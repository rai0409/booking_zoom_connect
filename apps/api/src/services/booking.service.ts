import { Injectable, BadRequestException, ConflictException, ForbiddenException, NotFoundException, UnauthorizedException } from "@nestjs/common";
import { Prisma, BookingStatus } from "@prisma/client";
import { GraphClient } from "../clients/graph.client";
import { ZoomClient } from "../clients/zoom.client";
import { prisma } from "../prisma";
import { parseIsoToUtc, utcNow, toIsoUtc, dateFromYmdLocal } from "../utils/time";
import { signBookingToken, verifyBookingToken, TokenPurpose } from "../utils/jwt";
import { DateTime } from "luxon";
import { log } from "../utils/logger";

const HOLD_TTL_MINUTES = 10;
const CANCEL_DEADLINE_HOURS = 24;

type AvailabilitySlot = { start_at_utc: string; end_at_utc: string };

@Injectable()
export class BookingService {
  private graph = new GraphClient();
  private zoom = new ZoomClient();
  private availabilityCache = new Map<string, { expiresAt: number; slots: AvailabilitySlot[] }>();

  private verifyBookingTokenOrThrow(token: string, expiredMsg = "token expired") {
    try {
      return verifyBookingToken(token);
    } catch (e: any) {
      if (e?.name === "TokenExpiredError") throw new UnauthorizedException(expiredMsg);
      throw new UnauthorizedException("invalid token");
    }
  }
  private availabilityCacheKey(tenantId: string, salespersonId: string, ymd: string) {
    return `${tenantId}:${salespersonId}:${ymd}`;
  }

  private invalidateAvailabilityCacheForStart(tenantId: string, salespersonId: string, timezone: string, startAtUtc: Date) {
    const ymd = DateTime.fromJSDate(startAtUtc, { zone: "utc" }).setZone(timezone).toFormat("yyyy-LL-dd");
    this.availabilityCache.delete(this.availabilityCacheKey(tenantId, salespersonId, ymd));
  }
  async getAvailability(tenantSlug: string, salespersonId: string, date: string) {
    if (!salespersonId) throw new BadRequestException("salesperson required");
    if (!date) throw new BadRequestException("date required");

    const tenant = await prisma.tenant.findUnique({ where: { slug: tenantSlug } });
    if (!tenant) throw new NotFoundException("Tenant not found");

    const salesperson = await prisma.salesperson.findFirst({
      where: { id: salespersonId, tenant_id: tenant.id, active: true }
    });
    if (!salesperson) throw new NotFoundException("Salesperson not found");

    const cacheKey = this.availabilityCacheKey(tenant.id, salesperson.id, date);
    const cached = this.availabilityCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.slots;
    }

    const dayStart = dateFromYmdLocal(date, salesperson.timezone);
    const slots: AvailabilitySlot[] = [];
    let cursor = dayStart.set({ hour: 9, minute: 0 });
    const dayEnd = dayStart.set({ hour: 17, minute: 0 });

    while (cursor < dayEnd) {
      const end = cursor.plus({ hours: 1 });
      slots.push({ start_at_utc: cursor.toUTC().toISO() || "", end_at_utc: end.toUTC().toISO() || "" });
      cursor = end;
    }

    const graphEnabled = process.env.GRAPH_ENABLED !== "0";

    let candidateSlots: AvailabilitySlot[] = slots;
    if (graphEnabled && tenant.m365_tenant_id && salesperson.graph_user_id) {
      let busy: { startUtc: string; endUtc: string }[] = [];
      try {
        busy = await this.graph.getBusySlots(
          tenant.m365_tenant_id,
          salesperson.graph_user_id,
          dayStart.toUTC().toISO() || "",
          dayEnd.toUTC().toISO() || ""
        );
      } catch (e) {
        // Graph 側が死んでいても公開予約APIを落とさない（MVP/商用の基本）
        log("warn", "availability_graph_busy_fetch_failed", {
          tenantSlug,
          salespersonId,
          err: e instanceof Error ? e.message : String(e)
        });
        busy = [];
      }

      candidateSlots = slots.filter((slot) => {
        const start = DateTime.fromISO(slot.start_at_utc, { zone: "utc" });
        const end = DateTime.fromISO(slot.end_at_utc, { zone: "utc" });
        return !busy.some((b) => {
          const bStart = DateTime.fromISO(b.startUtc, { zone: "utc" }).minus({ minutes: 10 });
          const bEnd = DateTime.fromISO(b.endUtc, { zone: "utc" }).plus({ minutes: 10 });
          return start < bEnd && end > bStart;
        });
      });
    }

    // Step A: confirmed + 有効hold/pending_verify を DB から引いて除外
    const now = utcNow();
    const dayStartUtc = dayStart.toUTC().toJSDate();
    const dayEndUtc = dayEnd.toUTC().toJSDate();
    const occupied = await prisma.booking.findMany({
      where: {
        tenant_id: tenant.id,
        salesperson_id: salesperson.id,
        start_at_utc: { lt: dayEndUtc },
        end_at_utc: { gt: dayStartUtc },
        OR: [
          { status: BookingStatus.confirmed },
          {
            status: { in: [BookingStatus.hold, BookingStatus.pending_verify] },
            hold: { is: { expires_at_utc: { gt: now } } }
          }
        ]
      },
      select: { start_at_utc: true, end_at_utc: true }
    });

    const dbFiltered = candidateSlots.filter((slot) => {
      const start = DateTime.fromISO(slot.start_at_utc, { zone: "utc" });
      const end = DateTime.fromISO(slot.end_at_utc, { zone: "utc" });
      return !occupied.some((b) => {
        const bStart = DateTime.fromJSDate(b.start_at_utc, { zone: "utc" });
        const bEnd = DateTime.fromJSDate(b.end_at_utc, { zone: "utc" });
        return start < bEnd && end > bStart;
      });
    });

    this.availabilityCache.set(cacheKey, { expiresAt: Date.now() + 45_000, slots: dbFiltered });
    return dbFiltered;
  }

  async createHold(tenantSlug: string, payload: {
    salesperson_id: string;
    start_at: string;
    end_at: string;
    customer: { email: string; name?: string; company?: string };
  }, idempotencyKey: string) {
    if (!idempotencyKey) throw new BadRequestException("Idempotency-Key required");
    const tenant = await prisma.tenant.findUnique({ where: { slug: tenantSlug } });
    if (!tenant) throw new NotFoundException("Tenant not found");

    const salesperson = await prisma.salesperson.findFirst({
      where: { id: payload.salesperson_id, tenant_id: tenant.id, active: true }
    });
    if (!salesperson) throw new NotFoundException("Salesperson not found");

    const startAt = parseIsoToUtc(payload.start_at);
    const endAt = parseIsoToUtc(payload.end_at);

    const customer = await prisma.customer.upsert({
      where: { tenant_id_email: { tenant_id: tenant.id, email: payload.customer.email } },
      update: {
        name: payload.customer.name,
        company: payload.customer.company
      },
      create: {
        tenant_id: tenant.id,
        email: payload.customer.email,
        name: payload.customer.name,
        company: payload.customer.company
      }
    });

    const now = utcNow();
    let booking;
    try {
      booking = await prisma.$transaction(async (tx) => {
      const lockKey = `hold:${tenant.id}:${salesperson.id}:${startAt.toISOString()}:${endAt.toISOString()}`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

      const existing = await tx.booking.findFirst({
        where: { tenant_id: tenant.id, idempotency_key: idempotencyKey },
        include: { hold: true }
      });
      if (existing) return existing;

      const slotExisting = await tx.booking.findFirst({
        where: {
          tenant_id: tenant.id,
          salesperson_id: salesperson.id,
          start_at_utc: startAt,
          end_at_utc: endAt
        },
        include: { hold: true }
      });
      if (slotExisting) {
        const holdValid =
          (slotExisting.status === BookingStatus.hold || slotExisting.status === BookingStatus.pending_verify) &&
          !!slotExisting.hold &&
          slotExisting.hold.expires_at_utc > now;

        if (slotExisting.status === BookingStatus.confirmed || holdValid) {
          throw new ConflictException("Slot already booked");
        }

        // stale/expired/canceled: reuse the row (update) instead of create
        return tx.booking.update({
          where: { id: slotExisting.id },
          data: {
            customer_id: customer.id,
            status: BookingStatus.hold,
            idempotency_key: idempotencyKey,
            verify_token_jti: null,
            hold: {
              upsert: {
                create: {
                  expires_at_utc: DateTime.fromJSDate(utcNow()).plus({ minutes: HOLD_TTL_MINUTES }).toJSDate()
                },
                update: {
                  expires_at_utc: DateTime.fromJSDate(utcNow()).plus({ minutes: HOLD_TTL_MINUTES }).toJSDate()
                }
              }
            }
          },
          include: { hold: true }
        });
      }

      const conflict = await tx.booking.findFirst({
        where: {
          tenant_id: tenant.id,
          salesperson_id: salesperson.id,
          start_at_utc: { lt: endAt },
          end_at_utc: { gt: startAt },
          OR: [
            { status: BookingStatus.confirmed },
            {
              status: { in: [BookingStatus.hold, BookingStatus.pending_verify] },
              hold: { is: { expires_at_utc: { gt: now } } }
            }
          ]
        },
        select: { id: true }
      });
      if (conflict) throw new ConflictException("Slot already booked");

      return tx.booking.create({
        data: {
          tenant_id: tenant.id,
          salesperson_id: salesperson.id,
          customer_id: customer.id,
          start_at_utc: startAt,
          end_at_utc: endAt,
          status: BookingStatus.hold,
          idempotency_key: idempotencyKey,
          hold: {
            create: {
              expires_at_utc: DateTime.fromJSDate(utcNow()).plus({ minutes: HOLD_TTL_MINUTES }).toJSDate()
            }
          }
        },
        include: { hold: true }
      });
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        const target = Array.isArray((err as any).meta?.target) ? (err as any).meta.target : [];
        const isSlotUnique =
          target.includes("tenant_id") &&
          target.includes("salesperson_id") &&
          target.includes("start_at_utc") &&
          target.includes("end_at_utc");
        if (isSlotUnique) throw new ConflictException("Slot already booked");
      }
      throw err;
    }
    this.invalidateAvailabilityCacheForStart(tenant.id, salesperson.id, salesperson.timezone, startAt);
    return booking;

  }

  async sendVerification(tenantSlug: string, bookingId: string, idempotencyKey: string) {
    if (!idempotencyKey) throw new BadRequestException("Idempotency-Key required");
    const tenant = await prisma.tenant.findUnique({ where: { slug: tenantSlug } });
    if (!tenant) throw new NotFoundException("Tenant not found");

    const existing = await this.checkIdempotency(tenant.id, "verify-email", idempotencyKey);
    if (existing) {
      const b = await prisma.booking.findFirst({
        where: { id: bookingId, tenant_id: tenant.id },
        include: { hold: true, customer: true }
      });
      if (!b || !b.hold) throw new NotFoundException("Booking not found");
      const allowedStatuses: BookingStatus[] = [BookingStatus.hold, BookingStatus.pending_verify];
      if (!allowedStatuses.includes(b.status)) throw new ConflictException("Invalid booking state");
      if (b.hold.expires_at_utc <= utcNow()) {
        await prisma.booking.update({ where: { id: b.id }, data: { status: BookingStatus.expired } });
        throw new ConflictException("Hold expired");
      }
      const exp = Math.floor(b.hold.expires_at_utc.getTime() / 1000);
      const jti = b.verify_token_jti || `verify-${b.id}`;
      const token = signBookingToken({ exp, jti, booking_id: b.id, tenant_id: tenant.id, purpose: "verify" });
      return { status: "sent", token };
    }

    const booking = await prisma.booking.findFirst({
      where: { id: bookingId, tenant_id: tenant.id },
      include: { hold: true, customer: true }
    });
    if (!booking || !booking.hold) throw new NotFoundException("Booking not found");
    const allowedStatuses: BookingStatus[] = [BookingStatus.hold, BookingStatus.pending_verify];
    if (!allowedStatuses.includes(booking.status)) {
      throw new ConflictException("Invalid booking state");
    }

    const now = utcNow();
    if (booking.hold.expires_at_utc <= now) {
      await prisma.booking.update({ where: { id: booking.id }, data: { status: BookingStatus.expired } });
      throw new ConflictException("Hold expired");
    }

    const exp = Math.floor(booking.hold.expires_at_utc.getTime() / 1000);
    const jti = booking.verify_token_jti || `verify-${booking.id}`;
    const token = signBookingToken({
      exp,
      jti,
      booking_id: booking.id,
      tenant_id: tenant.id,
      purpose: "verify"
    });

    await prisma.booking.update({
      where: { id: booking.id },
      data: {
        verify_token_jti: jti,
        status: BookingStatus.pending_verify
      }
    });

    const graphEnabled = process.env.GRAPH_ENABLED !== "0";
    if (graphEnabled && tenant.m365_tenant_id) {
      try {
        await this.graph.sendMail(tenant.m365_tenant_id, {
          to: booking.customer.email,
          subject: `Booking verification ${booking.id}`,
          body: `Please verify your booking: ${token}`
        });
      } catch (e) {
        log("warn", "verify_email_send_failed", {
          tenantSlug,
          bookingId: booking.id,
          err: e instanceof Error ? e.message : String(e)
        });
      }
    } else {
      log("info", "verify_email_send_skipped", { tenantSlug, bookingId: booking.id, graphEnabled });
    }


    await this.recordIdempotency(tenant.id, "verify-email", idempotencyKey);

    return { status: "sent", token };
  }

  async confirmBooking(tenantSlug: string, token: string, idempotencyKey: string) {
    if (!idempotencyKey) throw new BadRequestException("Idempotency-Key required");
    const tenant = await prisma.tenant.findUnique({ where: { slug: tenantSlug } });
    if (!tenant) throw new NotFoundException("Tenant not found");

    const tokenPayload = this.verifyBookingTokenOrThrow(token, "Hold expired");
    if (tokenPayload.purpose !== "verify") throw new ForbiddenException("Invalid token purpose");

    const existing = await this.checkIdempotency(tenant.id, "confirm", idempotencyKey);
    if (existing) {
      return prisma.booking.findFirst({ where: { id: tokenPayload.booking_id, tenant_id: tenant.id } });
    }

    const booking = await prisma.booking.findFirst({
      where: { id: tokenPayload.booking_id, tenant_id: tenant.id },
      include: { customer: true, salesperson: true, hold: true }
    });
    if (!booking || !booking.customer || !booking.salesperson) throw new NotFoundException("Booking not found");

    if (booking.verify_token_jti !== tokenPayload.jti) {
      throw new ForbiddenException("Token already used");
    }

    if (booking.status === BookingStatus.confirmed) {
      await this.recordIdempotency(tenant.id, "confirm", idempotencyKey);
      return booking;
    }

    if (booking.status !== BookingStatus.pending_verify) {
      throw new ConflictException("Invalid booking state");
    }

    if (booking.hold && booking.hold.expires_at_utc <= utcNow()) {
      await prisma.booking.update({ where: { id: booking.id }, data: { status: BookingStatus.expired } });
      throw new ConflictException("Hold expired");
    }

    const graphEnabled = process.env.GRAPH_ENABLED !== "0";
    const zoomEnabled = process.env.ZOOM_ENABLED !== "0";
    const integrationsEnabled =
      graphEnabled &&
      zoomEnabled &&
      !!tenant.m365_tenant_id &&
      !!booking.salesperson.graph_user_id;

    if (!integrationsEnabled) {
      const result = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${booking.id}))`;
        const latest = await tx.booking.findFirst({ where: { id: booking.id } });
        if (!latest || latest.status === BookingStatus.confirmed) return latest;
        return tx.booking.update({
          where: { id: booking.id },
          data: { status: BookingStatus.confirmed, verify_token_jti: null }
        });
      });
      await this.recordIdempotency(tenant.id, "confirm", idempotencyKey);
      this.availabilityCache.clear();
      return result;
    }

    const startIso = toIsoUtc(booking.start_at_utc);
    const endIso = toIsoUtc(booking.end_at_utc);

    let zoomMeeting: { meetingId: string; joinUrl: string; startUrl: string } | null = null;
    try {
      zoomMeeting = await this.zoom.createMeeting({
        topic: `Booking ${booking.id}`,
        startUtc: startIso,
        endUtc: endIso,
        timezone: booking.salesperson.timezone
      });
      const zm = zoomMeeting;
      if (!zm) throw new Error("zoomMeeting unexpectedly null");

      const graphEvent = await this.graph.createEvent(tenant.m365_tenant_id || "", {
        organizerUserId: booking.salesperson.graph_user_id,
        subject: `Booking ${booking.id}`,
        startUtc: startIso,
        endUtc: endIso,
        timezone: booking.salesperson.timezone,
        attendeeEmail: booking.customer.email,
        body: `Join URL: ${zm.joinUrl}`
      });

      const result = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${booking.id}))`;

        const latest = await tx.booking.findFirst({ where: { id: booking.id } });
        if (!latest || latest.status === BookingStatus.confirmed) return latest;

        await tx.meeting.create({
          data: {
            booking_id: booking.id,
            provider: "zoom",
            provider_meeting_id: zm.meetingId,
            join_url: zm.joinUrl,
            start_url: zm.startUrl
          }
        });

        await tx.graphEvent.create({
          data: {
            booking_id: booking.id,
            organizer_user_id: booking.salesperson.graph_user_id,
            event_id: graphEvent.eventId,
            iCalUId: graphEvent.iCalUId,
            etag: graphEvent.etag,
            updated_at: utcNow()
          }
        });

        return tx.booking.update({
          where: { id: booking.id },
          data: {
            status: BookingStatus.confirmed,
            verify_token_jti: null
          }
        });
      });

      await this.recordIdempotency(tenant.id, "confirm", idempotencyKey);
      return result;
    } catch (err) {
      if (zoomMeeting) {
        await prisma.compensationJob.create({
          data: {
            tenant_id: tenant.id,
            booking_id: booking.id,
            status: "pending",
            reason: "graph_failed_after_zoom"
          }
        });
        try {
          await this.zoom.deleteMeeting(zoomMeeting.meetingId);
        } catch {

        }
      }
      throw err;
    }
  }

  async cancelBooking(tenantSlug: string, bookingId: string, token: string, idempotencyKey: string) {
    if (!idempotencyKey) throw new BadRequestException("Idempotency-Key required");
    const tenant = await prisma.tenant.findUnique({ where: { slug: tenantSlug } });
    if (!tenant) throw new NotFoundException("Tenant not found");

    const booking = await prisma.booking.findFirst({
      where: { id: bookingId, tenant_id: tenant.id },
      include: { meeting: true, graph_event: true, salesperson: true },
    });
    if (!booking) throw new NotFoundException("Booking not found");

    const tz = booking.salesperson?.timezone ?? "utc";
    if (booking.status === BookingStatus.canceled) {
      await prisma.hold.deleteMany({ where: { booking_id: booking.id } });
      this.invalidateAvailabilityCacheForStart(tenant.id, booking.salesperson_id, tz, booking.start_at_utc);
      return { status: "canceled" };
    }

    const existing = await this.checkIdempotency(tenant.id, "cancel", idempotencyKey);
    if (existing) {
      await prisma.hold.deleteMany({ where: { booking_id: booking.id } });
      this.invalidateAvailabilityCacheForStart(tenant.id, booking.salesperson_id, tz, booking.start_at_utc);
      return { status: "canceled" };
    }

    if (!token) throw new BadRequestException("token required");
    const tokenPayload = this.verifyBookingTokenOrThrow(token);
    if (tokenPayload.purpose !== "cancel") throw new ForbiddenException("Invalid token purpose");
    if (tokenPayload.booking_id !== booking.id) throw new ForbiddenException("Token booking mismatch");
    if (tokenPayload.tenant_id !== tenant.id) throw new ForbiddenException("Token tenant mismatch");

    if (booking.status !== BookingStatus.confirmed) throw new ConflictException("Invalid booking state");
    const deadline = DateTime.fromJSDate(booking.start_at_utc).minus({ hours: CANCEL_DEADLINE_HOURS });
    if (DateTime.utc() > deadline) throw new ConflictException("Cancel deadline passed");

    await prisma.booking.update({ where: { id: booking.id }, data: { status: BookingStatus.canceled } });
    await prisma.hold.deleteMany({ where: { booking_id: booking.id } });

    try {
      if (booking.graph_event) {
        await this.graph.deleteEvent(
          tenant.m365_tenant_id || "",
          booking.graph_event.organizer_user_id,
          booking.graph_event.event_id
        );
      }
    } catch (e) {
      log("warn", "cancel_graph_delete_failed", {
        tenantSlug,
        bookingId: booking.id,
        err: e instanceof Error ? e.message : String(e),
      });
    }
    try {
      if (booking.meeting) {
        await this.zoom.deleteMeeting(booking.meeting.provider_meeting_id);
      }
    } catch (e) {
      log("warn", "cancel_zoom_delete_failed", {
        tenantSlug,
        bookingId: booking.id,
        err: e instanceof Error ? e.message : String(e),
      });
    }
    await this.recordIdempotency(tenant.id, "cancel", idempotencyKey);
    this.invalidateAvailabilityCacheForStart(tenant.id, booking.salesperson_id, tz, booking.start_at_utc);
    return { status: "canceled" };
  }

  async rescheduleBooking(
    tenantSlug: string,
    bookingId: string,
    token: string,
    payload: { new_start_at: string; new_end_at: string },
    idempotencyKey: string
  ) {
    if (!idempotencyKey) throw new BadRequestException("Idempotency-Key required");
    const tenant = await prisma.tenant.findUnique({ where: { slug: tenantSlug } });
    if (!tenant) throw new NotFoundException("Tenant not found");

    if (!token) throw new BadRequestException("token required");
    const tokenPayload = this.verifyBookingTokenOrThrow(token);
    if (tokenPayload.purpose !== "reschedule") throw new ForbiddenException("Invalid token purpose");
    if (tokenPayload.booking_id !== bookingId) throw new ForbiddenException("Token booking mismatch");
    if (tokenPayload.tenant_id !== tenant.id) throw new ForbiddenException("Token tenant mismatch");

    const booking = await prisma.booking.findFirst({
      where: { id: bookingId, tenant_id: tenant.id },
      include: { salesperson: true }
    });
    if (!booking) throw new NotFoundException("Booking not found");

    const existing = await this.checkIdempotency(tenant.id, "reschedule", idempotencyKey);
    if (existing) return { status: "rescheduled" };

    if (booking.status !== BookingStatus.confirmed) throw new ConflictException("Invalid booking state");

    const deadline = DateTime.fromJSDate(booking.start_at_utc).minus({ hours: CANCEL_DEADLINE_HOURS });
    if (DateTime.utc() > deadline) throw new ConflictException("Reschedule deadline passed");

    const newStartAt = parseIsoToUtc(payload.new_start_at);
    const newEndAt = parseIsoToUtc(payload.new_end_at);
    const now = utcNow();

    const newBooking = await prisma.$transaction(async (tx) => {

      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${booking.id}))`;

      const latest = await tx.booking.findFirst({ where: { id: booking.id } });
      if (!latest) throw new NotFoundException("Booking not found");
      if (latest.status !== BookingStatus.confirmed) throw new ConflictException("Invalid booking state");

      const slotExisting = await tx.booking.findFirst({
        where: {
          tenant_id: latest.tenant_id,
          salesperson_id: latest.salesperson_id,
          start_at_utc: { lt: newEndAt },
          end_at_utc: { gt: newStartAt },
          status: { in: [BookingStatus.confirmed, BookingStatus.hold, BookingStatus.pending_verify] },
          NOT: { id: latest.id }
        },
        include: { hold: true }
      });
      if (slotExisting) {
        const holdValid =
          (slotExisting.status === BookingStatus.hold || slotExisting.status === BookingStatus.pending_verify) &&
          !!slotExisting.hold &&
          slotExisting.hold.expires_at_utc > now;
        if (slotExisting.status === BookingStatus.confirmed || holdValid) {
          throw new ConflictException("Slot already taken");
        }
      }

      await tx.booking.update({ where: { id: latest.id }, data: { status: BookingStatus.canceled } });

      return tx.booking.create({
        data: {
          tenant_id: latest.tenant_id,
          salesperson_id: latest.salesperson_id,
          customer_id: latest.customer_id,
          start_at_utc: newStartAt,
          end_at_utc: newEndAt,
          status: BookingStatus.hold,
          idempotency_key: idempotencyKey,
          hold: {
            create: {
              expires_at_utc: DateTime.fromJSDate(now).plus({ minutes: HOLD_TTL_MINUTES }).toJSDate()
            }
          }
        }
      });
    });

    await this.recordIdempotency(tenant.id, "reschedule", idempotencyKey);

    const tz = booking.salesperson?.timezone ?? "utc";
    this.invalidateAvailabilityCacheForStart(tenant.id, booking.salesperson_id, tz, booking.start_at_utc);
    this.invalidateAvailabilityCacheForStart(tenant.id, booking.salesperson_id, tz, newStartAt);

    return { status: "rescheduled", booking_id: newBooking.id };
  }

  async recordAttendance(bookingId: string, tenantId: string, status: "attended" | "no_show") {
    const booking = await prisma.booking.findFirst({ where: { id: bookingId, tenant_id: tenantId } });
    if (!booking) throw new NotFoundException("Booking not found");

    await prisma.trackingEvent.create({
      data: {
        tenant_id: tenantId,
        booking_id: bookingId,
        type: status,
        occurred_at_utc: utcNow()
      }
    });

    return { status: "ok" };
  }

  async expireHolds() {
    const now = utcNow();
    const result = await prisma.booking.updateMany({
      where: {
        status: { in: [BookingStatus.hold, BookingStatus.pending_verify] },
        hold: { expires_at_utc: { lt: now } }
      },
      data: { status: BookingStatus.expired }
    });
    if (result.count > 0) this.availabilityCache.clear();
  }

  private async checkIdempotency(tenantId: string, scope: string, key: string) {
    const existing = await prisma.idempotencyKey.findUnique({
      where: { tenant_id_scope_key: { tenant_id: tenantId, scope, key } }
    });
    return Boolean(existing);
  }

  private async recordIdempotency(tenantId: string, scope: string, key: string) {
    try {
      await prisma.idempotencyKey.create({
        data: { tenant_id: tenantId, scope, key }
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        return;
      }
      throw err;
    }
  }

  issueToken(bookingId: string, tenantId: string, purpose: TokenPurpose, expSeconds: number, jti: string) {
    return signBookingToken({
      exp: expSeconds,
      jti,
      booking_id: bookingId,
      tenant_id: tenantId,
      purpose
    });
  }
}
