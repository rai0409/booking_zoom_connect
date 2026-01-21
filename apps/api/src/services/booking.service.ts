import { Injectable, BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { Prisma, BookingStatus } from "@prisma/client";
import { GraphClient } from "../clients/graph.client";
import { ZoomClient } from "../clients/zoom.client";
import { prisma } from "../prisma";
import { parseIsoToUtc, utcNow, toIsoUtc, dateFromYmdLocal } from "../utils/time";
import { signBookingToken, verifyBookingToken, TokenPurpose } from "../utils/jwt";
import { DateTime } from "luxon";

const HOLD_TTL_MINUTES = 10;
const CANCEL_DEADLINE_HOURS = 24;

type AvailabilitySlot = { start_at_utc: string; end_at_utc: string };

@Injectable()
export class BookingService {
  private graph = new GraphClient();
  private zoom = new ZoomClient();
  private availabilityCache = new Map<string, { expiresAt: number; slots: AvailabilitySlot[] }>();

  async getAvailability(tenantSlug: string, salespersonId: string, date: string) {
    const tenant = await prisma.tenant.findUnique({ where: { slug: tenantSlug } });
    if (!tenant) throw new NotFoundException("Tenant not found");

    const salesperson = await prisma.salesperson.findFirst({
      where: { id: salespersonId, tenant_id: tenant.id, active: true }
    });
    if (!salesperson) throw new NotFoundException("Salesperson not found");

    const cacheKey = `${tenant.id}:${salesperson.id}:${date}`;
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

    const busy = await this.graph.getBusySlots();
    const filtered = slots.filter((slot) => {
      const start = DateTime.fromISO(slot.start_at_utc, { zone: "utc" });
      const end = DateTime.fromISO(slot.end_at_utc, { zone: "utc" });
      return !busy.some((b) => {
        const bStart = DateTime.fromISO(b.startUtc, { zone: "utc" }).minus({ minutes: 10 });
        const bEnd = DateTime.fromISO(b.endUtc, { zone: "utc" }).plus({ minutes: 10 });
        return start < bEnd && end > bStart;
      });
    });

    this.availabilityCache.set(cacheKey, { expiresAt: Date.now() + 45_000, slots: filtered });
    return filtered;
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

    try {
      const booking = await prisma.booking.create({
        data: {
          tenant_id: tenant.id,
          salesperson_id: payload.salesperson_id,
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
      return booking;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        const existing = await prisma.booking.findFirst({
          where: { tenant_id: tenant.id, idempotency_key: idempotencyKey },
          include: { hold: true }
        });
        if (existing) return existing;
        throw new ConflictException("Slot already booked");
      }
      throw err;
    }
  }

  async sendVerification(tenantSlug: string, bookingId: string, idempotencyKey: string) {
    if (!idempotencyKey) throw new BadRequestException("Idempotency-Key required");
    const tenant = await prisma.tenant.findUnique({ where: { slug: tenantSlug } });
    if (!tenant) throw new NotFoundException("Tenant not found");

    const existing = await this.checkIdempotency(tenant.id, "verify-email", idempotencyKey);
    if (existing) {
      return { status: "sent" };
    }

    const booking = await prisma.booking.findFirst({
      where: { id: bookingId, tenant_id: tenant.id },
      include: { hold: true, customer: true }
    });
    if (!booking || !booking.hold) throw new NotFoundException("Booking not found");
    if (![BookingStatus.hold, BookingStatus.pending_verify].includes(booking.status)) {
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

    await this.graph.sendMail();
    await this.recordIdempotency(tenant.id, "verify-email", idempotencyKey);

    return { status: "sent", token };
  }

  async confirmBooking(tenantSlug: string, token: string, idempotencyKey: string) {
    if (!idempotencyKey) throw new BadRequestException("Idempotency-Key required");
    const tenant = await prisma.tenant.findUnique({ where: { slug: tenantSlug } });
    if (!tenant) throw new NotFoundException("Tenant not found");

    const payload = verifyBookingToken(token);
    if (payload.purpose !== "verify") throw new ForbiddenException("Invalid token purpose");

    const existing = await this.checkIdempotency(tenant.id, "confirm", idempotencyKey);
    if (existing) {
      return prisma.booking.findFirst({ where: { id: payload.booking_id, tenant_id: tenant.id } });
    }

    const booking = await prisma.booking.findFirst({
      where: { id: payload.booking_id, tenant_id: tenant.id },
      include: { customer: true, salesperson: true, hold: true }
    });
    if (!booking || !booking.customer || !booking.salesperson) throw new NotFoundException("Booking not found");

    if (booking.verify_token_jti !== payload.jti) {
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

      const graphEvent = await this.graph.createEvent({
        organizerUserId: booking.salesperson.graph_user_id,
        subject: `Booking ${booking.id}`,
        startUtc: startIso,
        endUtc: endIso,
        timezone: booking.salesperson.timezone,
        attendeeEmail: booking.customer.email,
        body: `Join URL: ${zoomMeeting.joinUrl}`
      });

      const result = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${booking.id}))`;

        const latest = await tx.booking.findFirst({ where: { id: booking.id } });
        if (!latest || latest.status === BookingStatus.confirmed) return latest;

        await tx.meeting.create({
          data: {
            booking_id: booking.id,
            provider: "zoom",
            provider_meeting_id: zoomMeeting.meetingId,
            join_url: zoomMeeting.joinUrl,
            start_url: zoomMeeting.startUrl
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
          await this.zoom.deleteMeeting();
        } catch {
          // ignore
        }
      }
      throw err;
    }
  }

  async cancelBooking(tenantSlug: string, bookingId: string, token: string, idempotencyKey: string) {
    if (!idempotencyKey) throw new BadRequestException("Idempotency-Key required");
    const tenant = await prisma.tenant.findUnique({ where: { slug: tenantSlug } });
    if (!tenant) throw new NotFoundException("Tenant not found");

    const payload = verifyBookingToken(token);
    if (payload.purpose !== "cancel") throw new ForbiddenException("Invalid token purpose");

    const booking = await prisma.booking.findFirst({
      where: { id: bookingId, tenant_id: tenant.id },
      include: { meeting: true, graph_event: true }
    });
    if (!booking) throw new NotFoundException("Booking not found");
    if (booking.status === BookingStatus.canceled) return { status: "canceled" };
    if (booking.status !== BookingStatus.confirmed) throw new ConflictException("Invalid booking state");

    const deadline = DateTime.fromJSDate(booking.start_at_utc).minus({ hours: CANCEL_DEADLINE_HOURS });
    if (DateTime.utc() > deadline) {
      throw new ConflictException("Cancel deadline passed");
    }

    const existing = await this.checkIdempotency(tenant.id, "cancel", idempotencyKey);
    if (existing) return { status: "canceled" };

    await prisma.booking.update({ where: { id: booking.id }, data: { status: BookingStatus.canceled } });
    await this.graph.deleteEvent();
    await this.zoom.deleteMeeting();
    await this.recordIdempotency(tenant.id, "cancel", idempotencyKey);

    return { status: "canceled" };
  }

  async rescheduleBooking(tenantSlug: string, bookingId: string, token: string, payload: { new_start_at: string; new_end_at: string }, idempotencyKey: string) {
    if (!idempotencyKey) throw new BadRequestException("Idempotency-Key required");
    const tenant = await prisma.tenant.findUnique({ where: { slug: tenantSlug } });
    if (!tenant) throw new NotFoundException("Tenant not found");

    const payloadToken = verifyBookingToken(token);
    if (payloadToken.purpose !== "reschedule") throw new ForbiddenException("Invalid token purpose");

    const booking = await prisma.booking.findFirst({ where: { id: bookingId, tenant_id: tenant.id } });
    if (!booking) throw new NotFoundException("Booking not found");
    if (booking.status !== BookingStatus.confirmed) throw new ConflictException("Invalid booking state");

    const existing = await this.checkIdempotency(tenant.id, "reschedule", idempotencyKey);
    if (existing) {
      return { status: "rescheduled" };
    }

    const deadline = DateTime.fromJSDate(booking.start_at_utc).minus({ hours: CANCEL_DEADLINE_HOURS });
    if (DateTime.utc() > deadline) {
      throw new ConflictException("Reschedule deadline passed");
    }

    const startAt = parseIsoToUtc(payload.new_start_at);
    const endAt = parseIsoToUtc(payload.new_end_at);

    await prisma.booking.update({ where: { id: booking.id }, data: { status: BookingStatus.canceled } });

    const newBooking = await prisma.booking.create({
      data: {
        tenant_id: booking.tenant_id,
        salesperson_id: booking.salesperson_id,
        customer_id: booking.customer_id,
        start_at_utc: startAt,
        end_at_utc: endAt,
        status: BookingStatus.hold,
        idempotency_key: idempotencyKey,
        hold: {
          create: {
            expires_at_utc: DateTime.fromJSDate(utcNow()).plus({ minutes: HOLD_TTL_MINUTES }).toJSDate()
          }
        }
      }
    });

    await this.recordIdempotency(tenant.id, "reschedule", idempotencyKey);
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
    await prisma.booking.updateMany({
      where: {
        status: { in: [BookingStatus.hold, BookingStatus.pending_verify] },
        hold: { expires_at_utc: { lt: now } }
      },
      data: { status: BookingStatus.expired }
    });
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
