import { Injectable, BadRequestException, ConflictException, ForbiddenException, NotFoundException, UnauthorizedException, Logger } from "@nestjs/common";
import { Prisma, BookingStatus } from "@prisma/client";
import { GraphClient } from "../clients/graph.client";
import { config } from "../config";
import { GraphMailSender } from "../mail/graph-mail-sender";
import { MailSender } from "../mail/mail-sender";
import { ZoomClient } from "../clients/zoom.client";
import { prisma } from "../prisma";
import { parseIsoToUtc, utcNow, toIsoUtc, dateFromYmdLocal } from "../utils/time";
import { signBookingToken, verifyBookingToken, TokenPurpose } from "../utils/jwt";
import { DateTime } from "luxon";
import { log } from "../utils/logger";
import { randomBytes, randomUUID } from "crypto";

const HOLD_TTL_MINUTES = 10;
const CANCEL_DEADLINE_HOURS = 24;

type AvailabilitySlot = { start_at_utc: string; end_at_utc: string };
type BusySlot = { startUtc: string; endUtc: string };
type BookingMode = "online" | "offline";
type AvailabilityContext = {
  tzForAvailability: string;
  bufferMinutes: number;
  dayOpen: DateTime;
  dayEnd: DateTime;
  slots: AvailabilitySlot[];
  dayStartUtc: Date;
  dayEndUtc: Date;
};

type PublicHoldResponse = {
  booking_id: string;
  public_confirm_token: string;
  id: string;
  status: BookingStatus;
  start_at_utc: string;
  end_at_utc: string;
  hold: { expires_at_utc: string } | null;
};

type PublicSalesperson = { id: string; display_name: string; timezone: string };
type ListBookingsInternalParams = { from?: string; to?: string; limit?: number; includeEvents?: boolean };
type InternalBookingEvent = { type: string; occurred_at_utc: string; meta_json: unknown };
type InternalBookingListItem = {
  id: string;
  status: BookingStatus;
  start_at_utc: string;
  end_at_utc: string;
  booking_mode: string | null;
  public_notes: string | null;
  customer: { email: string; name: string | null; company: string | null };
  salesperson: { display_name: string; timezone: string };
  meeting: { provider: string; join_url?: string } | null;
  events?: InternalBookingEvent[];
};

@Injectable()
export class BookingService {
  private graph = new GraphClient();
  private zoom = new ZoomClient();
  private mailSender: MailSender = new GraphMailSender(this.graph);
  private availabilityCache = new Map<string, { expiresAt: number; slots: AvailabilitySlot[] }>();
  private readonly logger = new Logger(BookingService.name);
  private static readonly UNION_SCOPE = "__union__";

  private buildEventSubject(): string {
    return "Appointment";
  }

  private buildEventBody(): string {
    // Outlook event must not contain internal details.
    return "Appointment";
  }

  private buildConfirmationEmail(params: {
    startIsoUtc: string;
    endIsoUtc: string;
    timezone: string;
    bookingMode: BookingMode;
    zoomJoinUrl?: string | null;
    locationText?: string | null;
    cancelUrl: string;
    rescheduleUrl: string;
  }): { subject: string; body: string } {
    const startLocal = DateTime.fromISO(params.startIsoUtc, { zone: "utc" })
      .setZone(params.timezone)
      .toFormat("yyyy-LL-dd HH:mm");
    const endLocal = DateTime.fromISO(params.endIsoUtc, { zone: "utc" })
      .setZone(params.timezone)
      .toFormat("HH:mm");

    const lines: string[] = [];
    lines.push("Your appointment is confirmed.");
    lines.push(`Date/Time: ${startLocal} - ${endLocal} (${params.timezone})`);
    if (params.bookingMode === "online") {
      lines.push(`Online meeting: ${params.zoomJoinUrl || "Link will be shared separately."}`);
    } else {
      lines.push(`Location: ${params.locationText || "Details will be shared separately."}`);
    }
    lines.push(`Cancel: ${params.cancelUrl}`);
    lines.push(`Reschedule: ${params.rescheduleUrl}`);

    return {
      subject: "Appointment confirmed",
      body: lines.join("\n")
    };
  }

  private buildCustomerActionLinks(tenantSlug: string, bookingId: string, tenantId: string, startAtUtc: Date) {
    const exp = Math.floor(DateTime.fromJSDate(startAtUtc, { zone: "utc" }).toSeconds());
    const now = Date.now();
    const cancelToken = this.issueToken(bookingId, tenantId, "cancel", exp, `cancel-${bookingId}-${now}`);
    const rescheduleToken = this.issueToken(bookingId, tenantId, "reschedule", exp, `reschedule-${bookingId}-${now}`);
    const bookingIdQuery = encodeURIComponent(bookingId);
    return {
      cancelUrl: `${config.baseUrl}/public/${tenantSlug}?action=cancel&booking_id=${bookingIdQuery}&token=${encodeURIComponent(cancelToken)}`,
      rescheduleUrl: `${config.baseUrl}/public/${tenantSlug}?action=reschedule&booking_id=${bookingIdQuery}&token=${encodeURIComponent(rescheduleToken)}`
    };
  }

  async buildCustomerLinksInternal(tenantSlug: string, bookingId: string) {
    const tenant = await prisma.tenant.findUnique({
      where: { slug: tenantSlug },
      select: { id: true }
    });
    if (!tenant) throw new NotFoundException("Tenant not found");

    const booking = await prisma.booking.findFirst({
      where: { id: bookingId, tenant_id: tenant.id },
      select: { id: true, start_at_utc: true }
    });
    if (!booking) throw new NotFoundException("Booking not found");

    const links = this.buildCustomerActionLinks(tenantSlug, booking.id, tenant.id, booking.start_at_utc);
    return { booking_id: booking.id, cancel_url: links.cancelUrl, reschedule_url: links.rescheduleUrl };
  }

  private canPatchGraphEvent(tenant: { m365_tenant_id: string | null }, booking: {
    graph_event?: { organizer_user_id: string; event_id: string } | null;
  }) {
    return (
      process.env.GRAPH_ENABLED !== "0" &&
      !!tenant.m365_tenant_id &&
      !!booking.graph_event?.organizer_user_id &&
      !!booking.graph_event?.event_id
    );
  }

  private async patchGraphEventTimesBestEffort(params: {
    tenantId: string;
    m365TenantId: string;
    bookingId: string;
    organizerUserId: string;
    eventId: string;
    startUtc: Date;
    endUtc: Date;
    action: string;
  }) {
    try {
      const patched = await this.graph.updateEventTimes(
        params.m365TenantId,
        params.organizerUserId,
        params.eventId,
        {
          startUtc: toIsoUtc(params.startUtc),
          endUtc: toIsoUtc(params.endUtc)
        }
      );
      await prisma.$transaction(async (tx) => {
        await tx.graphEvent.update({
          where: { booking_id: params.bookingId },
          data: {
            etag: patched.etag,
            updated_at: utcNow()
          }
        });
        await tx.booking.update({
          where: { id: params.bookingId },
          data: { customer_reinvite_required: false }
        });
      });
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      log("warn", "graph_patch_failed", {
        action: params.action,
        bookingId: params.bookingId,
        organizerUserId: params.organizerUserId,
        eventId: params.eventId,
        err
      });
      await prisma.$transaction(async (tx) => {
        await tx.booking.update({
          where: { id: params.bookingId },
          data: { customer_reinvite_required: true }
        });
        await tx.trackingEvent.create({
          data: {
            tenant_id: params.tenantId,
            booking_id: params.bookingId,
            type: "graph.patch_failed",
            occurred_at_utc: utcNow(),
            meta_json: {
              action: params.action,
              booking_id: params.bookingId,
              organizer_user_id: params.organizerUserId,
              event_id: params.eventId,
              error: err
            }
          }
        });
      });
    }
  }

  private normalizeBookingMode(mode: string | undefined): BookingMode {
    if (!mode || mode === "online") return "online";
    if (mode === "offline") return "offline";
    throw new BadRequestException("booking_mode must be 'online' or 'offline'");
  }

  private normalizePublicNotes(notes: string | undefined): string | null {
    if (!notes) return null;
    const oneLine = notes.replace(/\r?\n/g, " ").trim().replace(/\s+/g, " ");
    return oneLine ? oneLine.slice(0, 500) : null;
  }

  private generatePublicConfirmToken() {
    return randomBytes(16).toString("hex");
  }

  private async readPublicConfirmToken(client: any, bookingId: string): Promise<string | null> {
    const rows = await client.$queryRaw<Array<{ public_confirm_token: string | null }>>`
      SELECT "public_confirm_token"
      FROM "bookings"
      WHERE "id" = ${bookingId}::uuid
      LIMIT 1
    `;
    return rows[0]?.public_confirm_token ?? null;
  }

  private async writePublicConfirmToken(client: any, bookingId: string, token: string | null) {
    await client.$executeRaw`
      UPDATE "bookings"
      SET "public_confirm_token" = ${token}
      WHERE "id" = ${bookingId}::uuid
    `;
  }

  private async ensureGraphEventForConfirmedBookingBestEffort(params: {
    tenantSlug: string;
    tenant: { id: string; m365_tenant_id: string | null };
    booking: {
      id: string;
      start_at_utc: Date;
      end_at_utc: Date;
      customer: { email: string };
      salesperson: { graph_user_id: string | null; timezone: string };
      graph_event: { event_id: string } | null;
    };
  }) {
    if (process.env.GRAPH_ENABLED === "0") return;
    if (!params.tenant.m365_tenant_id || !params.booking.salesperson.graph_user_id) return;
    if (params.booking.graph_event?.event_id) return;

    try {
      const created = await this.graph.createEvent(params.tenant.m365_tenant_id, {
        organizerUserId: params.booking.salesperson.graph_user_id,
        subject: this.buildEventSubject(),
        startUtc: toIsoUtc(params.booking.start_at_utc),
        endUtc: toIsoUtc(params.booking.end_at_utc),
        timezone: params.booking.salesperson.timezone,
        attendeeEmail: params.booking.customer.email,
        body: this.buildEventBody(),
        transactionId: `booking:${params.booking.id}`
      });

      await prisma.graphEvent.upsert({
        where: { booking_id: params.booking.id },
        create: {
          booking_id: params.booking.id,
          organizer_user_id: params.booking.salesperson.graph_user_id,
          event_id: created.eventId,
          iCalUId: created.iCalUId,
          etag: created.etag,
          updated_at: utcNow()
        },
        update: {
          organizer_user_id: params.booking.salesperson.graph_user_id,
          event_id: created.eventId,
          iCalUId: created.iCalUId,
          etag: created.etag,
          updated_at: utcNow()
        }
      });
    } catch (e) {
      log("warn", "confirm_graph_create_failed", {
        tenantSlug: params.tenantSlug,
        bookingId: params.booking.id,
        err: e instanceof Error ? e.message : String(e)
      });
    }
  }

  private async runPostConfirmBestEffort(tenantSlug: string, bookingId: string) {
    const tenant = await prisma.tenant.findUnique({
      where: { slug: tenantSlug },
      select: { id: true, m365_tenant_id: true, public_location_text: true }
    });
    if (!tenant) return;

    const booking = await prisma.booking.findFirst({
      where: { id: bookingId, tenant_id: tenant.id },
      include: {
        customer: true,
        salesperson: true,
        meeting: true,
        graph_event: true
      }
    });
    if (!booking || !booking.customer || !booking.salesperson) return;

    await this.ensureGraphEventForConfirmedBookingBestEffort({
      tenantSlug,
      tenant,
      booking: {
        id: booking.id,
        start_at_utc: booking.start_at_utc,
        end_at_utc: booking.end_at_utc,
        customer: { email: booking.customer.email },
        salesperson: {
          graph_user_id: booking.salesperson.graph_user_id,
          timezone: booking.salesperson.timezone
        },
        graph_event: booking.graph_event
      }
    });

    await this.sendConfirmationEmailBestEffort({
      tenantSlug,
      tenant,
      booking,
      zoomJoinUrl: booking.meeting?.join_url ?? null
    });
  }

  private parseInternalDateParam(value: string | undefined, name: "from" | "to"): Date | undefined {
    if (!value) return undefined;
    const dt = DateTime.fromISO(value, { setZone: true });
    if (!dt.isValid) {
      throw new BadRequestException(`${name} must be a valid ISO-8601 datetime`);
    }
    return dt.toUTC().toJSDate();
  }

  private parseInternalLimit(limit: number | undefined): number {
    if (limit === undefined) return 100;
    if (!Number.isFinite(limit)) throw new BadRequestException("limit must be a number");
    const parsed = Math.floor(limit);
    return Math.max(1, Math.min(500, parsed));
  }

  private availabilityCacheKey(tenantId: string, scope: string, ymd: string) {
    return `${tenantId}:${scope}:${ymd}`;
  }

  private invalidateAvailabilityCacheForStart(tenantId: string, salespersonId: string, timezone: string, startAtUtc: Date) {
    const ymd = DateTime.fromJSDate(startAtUtc, { zone: "utc" }).setZone(timezone).toFormat("yyyy-LL-dd");
    this.availabilityCache.delete(this.availabilityCacheKey(tenantId, salespersonId, ymd));
    this.availabilityCache.delete(this.availabilityCacheKey(tenantId, BookingService.UNION_SCOPE, ymd));
  }

  private parseBusinessHours(tenant: { public_business_hours: Prisma.JsonValue | null }) {
    const cfg = (tenant.public_business_hours || {}) as any;
    const slotMinutes = Number(cfg.slot_minutes ?? 60);
    const leadTimeMinutes = Number(cfg.lead_time_minutes ?? 0);
    const bufferMinutes = Number(cfg.buffer_minutes ?? 10);
    const maxDaysAhead = Number(cfg.max_days_ahead ?? 7);
    const closedDates: string[] = Array.isArray(cfg.closed_dates) ? cfg.closed_dates : [];
    const weekly = (cfg.weekly || {}) as Record<string, any>;
    return { slotMinutes, leadTimeMinutes, bufferMinutes, maxDaysAhead, closedDates, weekly };
  }

  private parseHm(hm: string, fallback: number) {
    if (!hm || typeof hm !== "string") return fallback;
    const m = hm.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
    if (!m) return fallback;
    return Number(m[1]) * 60 + Number(m[2]);
  }

  private buildAvailabilityContext(
    tenant: { public_business_hours: Prisma.JsonValue | null },
    date: string,
    tzForAvailability: string
  ): AvailabilityContext | null {
    const dayStart = dateFromYmdLocal(date, tzForAvailability);
    const { slotMinutes, leadTimeMinutes, bufferMinutes, maxDaysAhead, closedDates, weekly } = this.parseBusinessHours(tenant);

    const todayLocal = DateTime.utc().setZone(tzForAvailability).startOf("day");
    const targetLocal = dayStart.startOf("day");
    if (targetLocal < todayLocal) return null;
    if (targetLocal > todayLocal.plus({ days: maxDaysAhead })) return null;
    if (closedDates.includes(date)) return null;

    const weekdayKey = targetLocal.toFormat("ccc").toLowerCase();
    const dayCfg = weekly[weekdayKey];
    const openMin = this.parseHm(dayCfg?.open, 9 * 60);
    const closeMin = this.parseHm(dayCfg?.close, 17 * 60);
    if (closeMin <= openMin) return null;

    const breaks = Array.isArray(dayCfg?.breaks) ? dayCfg.breaks : [];
    const breakRanges = breaks
      .map((b: any) => ({
        startMin: this.parseHm(b?.start, -1),
        endMin: this.parseHm(b?.end, -1)
      }))
      .filter((r: any) => r.startMin >= 0 && r.endMin > r.startMin);

    const dayOpen = targetLocal.set({ hour: Math.floor(openMin / 60), minute: openMin % 60, second: 0, millisecond: 0 });
    const dayEnd = targetLocal.set({ hour: Math.floor(closeMin / 60), minute: closeMin % 60, second: 0, millisecond: 0 });
    const leadCutoffUtc = DateTime.utc().plus({ minutes: leadTimeMinutes });

    const slots: AvailabilitySlot[] = [];
    let cursor = dayOpen;
    while (cursor.plus({ minutes: slotMinutes }) <= dayEnd) {
      const end = cursor.plus({ minutes: slotMinutes });
      const startMinLocal = cursor.hour * 60 + cursor.minute;
      const endMinLocal = end.hour * 60 + end.minute;
      const overlapsBreak = breakRanges.some((r: any) => startMinLocal < r.endMin && endMinLocal > r.startMin);
      if (!overlapsBreak) {
        const startUtc = cursor.toUTC();
        if (startUtc >= leadCutoffUtc) {
          slots.push({
            start_at_utc: startUtc.toISO() || "",
            end_at_utc: end.toUTC().toISO() || ""
          });
        }
      }
      cursor = end;
    }

    return {
      tzForAvailability,
      bufferMinutes,
      dayOpen,
      dayEnd,
      slots,
      dayStartUtc: dayOpen.toUTC().toJSDate(),
      dayEndUtc: dayEnd.toUTC().toJSDate()
    };
  }

  private slotOverlapsBusy(slot: AvailabilitySlot, busy: BusySlot[], bufferMinutes: number) {
    const start = DateTime.fromISO(slot.start_at_utc, { zone: "utc" });
    const end = DateTime.fromISO(slot.end_at_utc, { zone: "utc" });
    return busy.some((b) => {
      const bStart = DateTime.fromISO(b.startUtc, { zone: "utc" }).minus({ minutes: bufferMinutes });
      const bEnd = DateTime.fromISO(b.endUtc, { zone: "utc" }).plus({ minutes: bufferMinutes });
      return start < bEnd && end > bStart;
    });
  }


  // ---- Public boundary (tenant gate) ----
  private async getPublicTenantOrThrow(tenantSlug: string) {
    const tenant = await prisma.tenant.findUnique({
      where: { slug: tenantSlug },
      select: { id: true, public_booking_enabled: true }
    });
    // Boundary: if disabled, behave as not found (do not leak existence)
    if (!tenant || !tenant.public_booking_enabled) throw new NotFoundException("Tenant not found");
    return tenant;
  }

  async getAvailabilityPublic(tenantSlug: string, salespersonId: string | undefined, date: string, requestId?: string) {
    await this.getPublicTenantOrThrow(tenantSlug);
    log("info", "availability_requested", { tenantSlug, requestId, salespersonId: salespersonId ?? null, date });
    return this.getAvailability(tenantSlug, salespersonId, date);
  }

  async listSalespersonsPublic(tenantSlug: string): Promise<PublicSalesperson[]> {
    const tenant = await this.getPublicTenantOrThrow(tenantSlug);
    return prisma.salesperson.findMany({
      where: { tenant_id: tenant.id, active: true },
      orderBy: { display_name: "asc" },
      select: { id: true, display_name: true, timezone: true }
    });
  }

  async createHoldPublic(
    tenantSlug: string,
    payload: {
      salesperson_id?: string;
      start_at: string;
      end_at: string;
      booking_mode?: string;
      public_notes?: string;
      customer: { email: string; name?: string; company?: string };
    },
    idempotencyKey: string,
    requestId?: string
  ): Promise<PublicHoldResponse> {
    await this.getPublicTenantOrThrow(tenantSlug);
    const booking = await this.createHold(tenantSlug, payload, idempotencyKey, requestId);
    let publicConfirmToken = await this.readPublicConfirmToken(prisma, booking.id);
    if (!publicConfirmToken) {
      publicConfirmToken = this.generatePublicConfirmToken();
      await this.writePublicConfirmToken(prisma, booking.id, publicConfirmToken);
    }
    return {
      booking_id: booking.id,
      public_confirm_token: publicConfirmToken,
      id: booking.id,
      status: booking.status,
      start_at_utc: toIsoUtc(booking.start_at_utc),
      end_at_utc: toIsoUtc(booking.end_at_utc),
      hold: booking.hold ? { expires_at_utc: toIsoUtc(booking.hold.expires_at_utc) } : null
    };
  }

  async sendVerificationPublic(tenantSlug: string, bookingId: string, idempotencyKey: string, requestId?: string) {
    await this.getPublicTenantOrThrow(tenantSlug);
    const result = await this.sendVerification(tenantSlug, bookingId, idempotencyKey, requestId);
    if (process.env.PUBLIC_RETURN_VERIFY_TOKEN === "1") {
      return result;
    }
    return { status: result.status };
  }

  async confirmBookingPublic(tenantSlug: string, token: string, idempotencyKey: string, requestId?: string) {
    const tenant = await this.getPublicTenantOrThrow(tenantSlug);
    const booking = await this.confirmBooking(tenantSlug, token, idempotencyKey, requestId);
    if (!booking) throw new NotFoundException("Booking not found");
    const links = this.buildCustomerActionLinks(tenantSlug, booking.id, tenant.id, booking.start_at_utc);
    return { status: "confirmed", booking_id: booking.id, cancel_url: links.cancelUrl, reschedule_url: links.rescheduleUrl };
  }
  async confirmBookingPublicById(tenantSlug: string, bookingId: string, token: string, idempotencyKey: string, requestId?: string) {
    await this.getPublicTenantOrThrow(tenantSlug);
    const booking = await this.confirmBookingById(tenantSlug, bookingId, token, idempotencyKey, requestId);
    if (!booking) throw new NotFoundException("Booking not found");
    return { status: "ok", booking };
  }

  async confirmBookingById(tenantSlug: string, bookingId: string, token: string, idempotencyKey: string, requestId?: string) {
    log("info", "confirm_by_id_requested", { tenantSlug, bookingId, requestId });
    const tenant = await prisma.tenant.findUnique({ where: { slug: tenantSlug } });
    if (!tenant) throw new NotFoundException("Tenant not found");
    if (!idempotencyKey) throw new BadRequestException("Idempotency-Key required");
    if (!token) throw new BadRequestException("token required");

    const existing = await this.checkIdempotency(tenant.id, "confirm-by-id", idempotencyKey);
    if (existing) {
      return prisma.booking.findFirst({ where: { id: bookingId, tenant_id: tenant.id } });
    }

    const booking = await prisma.booking.findFirst({
      where: { id: bookingId, tenant_id: tenant.id },
      select: {
        id: true,
        status: true,
        created_at: true
      }
    });
    if (!booking) return null;
    const publicConfirmToken = await this.readPublicConfirmToken(prisma, booking.id);
    if (booking.status !== BookingStatus.hold) {
      throw new ConflictException("Invalid booking state");
    }
    if (publicConfirmToken !== token) {
      throw new BadRequestException("invalid public confirm token");
    }
    if (DateTime.fromJSDate(booking.created_at, { zone: "utc" }).plus({ minutes: 15 }).toMillis() <= Date.now()) {
      throw new BadRequestException("public confirm token expired");
    }

    const confirmed = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${booking.id}))`;

      const latest = await tx.booking.findFirst({
        where: { id: booking.id, tenant_id: tenant.id },
        select: {
          id: true,
          status: true,
          created_at: true
        }
      });
      if (!latest) return null;
      const latestPublicConfirmToken = await this.readPublicConfirmToken(tx, latest.id);
      if (latest.status !== BookingStatus.hold) {
        throw new ConflictException("Invalid booking state");
      }
      if (latestPublicConfirmToken !== token) {
        throw new BadRequestException("invalid public confirm token");
      }
      if (DateTime.fromJSDate(latest.created_at, { zone: "utc" }).plus({ minutes: 15 }).toMillis() <= Date.now()) {
        throw new BadRequestException("public confirm token expired");
      }

      const updated = await tx.booking.update({
        where: { id: booking.id },
        data: {
          status: BookingStatus.confirmed,
          verify_token_jti: null
        }
      });
      await this.writePublicConfirmToken(tx, booking.id, null);
      await tx.hold.deleteMany({ where: { booking_id: booking.id } });
      return updated;
    });

    if (!confirmed) return null;
    await this.recordIdempotency(tenant.id, "confirm-by-id", idempotencyKey);
    await this.runPostConfirmBestEffort(tenantSlug, confirmed.id);
    return confirmed;
  }



  async cancelBookingPublic(tenantSlug: string, bookingId: string, token: string, idempotencyKey: string, requestId?: string) {
    await this.getPublicTenantOrThrow(tenantSlug);
    return this.cancelBooking(tenantSlug, bookingId, token, idempotencyKey, requestId);
  }

  async rescheduleBookingPublic(
    tenantSlug: string,
    bookingId: string,
    token: string,
    payload: { new_start_at: string; new_end_at: string },
    idempotencyKey: string,
    requestId?: string
  ) {
    await this.getPublicTenantOrThrow(tenantSlug);
    return this.rescheduleBooking(tenantSlug, bookingId, token, payload, idempotencyKey, requestId);
  }

  private verifyBookingTokenOrThrow(token: string, expiredMsg = "token expired") {
    try {
      return verifyBookingToken(token);
    } catch (e: any) {
      if (e?.name === "TokenExpiredError") throw new UnauthorizedException(expiredMsg);
      throw new UnauthorizedException("invalid token");
    }
  }
  private async getGraphBusyMap(params: {
    tenantSlug: string;
    tenantId: string;
    m365TenantId: string | null;
    salespersons: Array<{ id: string; graph_user_id: string }>;
    startIso: string;
    endIso: string;
  }) {
    const busyBySalesperson = new Map<string, BusySlot[]>();
    for (const salesperson of params.salespersons) {
      busyBySalesperson.set(salesperson.id, []);
    }

    if (process.env.GRAPH_ENABLED === "0") return busyBySalesperson;
    if (!params.m365TenantId) return busyBySalesperson;

    for (const salesperson of params.salespersons) {
      if (!salesperson.graph_user_id) continue;
      try {
        const busy = await this.graph.getBusySlots(
          params.m365TenantId,
          salesperson.graph_user_id,
          params.startIso,
          params.endIso
        );
        if (process.env.GRAPH_BUSY_DEBUG === "1") {
          log("info", "availability_graph_busy_debug", {
            tenantSlug: params.tenantSlug,
            tenantId: params.tenantId,
            salespersonId: salesperson.id,
            graphUserId: salesperson.graph_user_id,
            startIso: params.startIso,
            endIso: params.endIso,
            busyCount: busy.length,
            sample: busy.slice(0, 5)
          });
        }
        busyBySalesperson.set(salesperson.id, busy);
      } catch (e) {
        log("warn", "availability_graph_busy_fetch_failed", {
          tenantSlug: params.tenantSlug,
          tenantId: params.tenantId,
          salespersonId: salesperson.id,
          err: e instanceof Error ? e.message : String(e)
        });
      }
    }

    return busyBySalesperson;
  }

  async getAvailability(tenantSlug: string, salespersonId: string | undefined, date: string) {
    if (!date) throw new BadRequestException("date required");

    const tenant = await prisma.tenant.findUnique({ where: { slug: tenantSlug } });
    if (!tenant) throw new NotFoundException("Tenant not found");

    const targetSalespersons = salespersonId
      ? await prisma.salesperson.findMany({
          where: { id: salespersonId, tenant_id: tenant.id, active: true },
          orderBy: { display_name: "asc" },
          select: { id: true, display_name: true, timezone: true, graph_user_id: true }
        })
      : await prisma.salesperson.findMany({
          where: { tenant_id: tenant.id, active: true },
          orderBy: { display_name: "asc" },
          select: { id: true, display_name: true, timezone: true, graph_user_id: true }
        });

    if (salespersonId && targetSalespersons.length === 0) throw new NotFoundException("Salesperson not found");
    if (targetSalespersons.length === 0) return [];

    const tzForAvailability =
      (salespersonId ? targetSalespersons[0]?.timezone : undefined) || tenant.public_timezone || "Asia/Tokyo";
    const ctx = this.buildAvailabilityContext(tenant, date, tzForAvailability);
    if (!ctx) return [];

    const scope = salespersonId || BookingService.UNION_SCOPE;
    const cacheKey = this.availabilityCacheKey(tenant.id, scope, date);
    const cached = this.availabilityCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.slots;
    }

    const now = utcNow();
    const salespersonIds = targetSalespersons.map((s) => s.id);
    const occupied = await prisma.booking.findMany({
      where: {
        tenant_id: tenant.id,
        salesperson_id: { in: salespersonIds },
        start_at_utc: { lt: ctx.dayEndUtc },
        end_at_utc: { gt: ctx.dayStartUtc },
        OR: [
          { status: BookingStatus.confirmed },
          {
            status: { in: [BookingStatus.hold, BookingStatus.pending_verify] },
            hold: { is: { expires_at_utc: { gt: now } } }
          }
        ]
      },
      select: { salesperson_id: true, start_at_utc: true, end_at_utc: true }
    });

    const dbBusyBySalesperson = new Map<string, BusySlot[]>();
    for (const salesperson of targetSalespersons) {
      dbBusyBySalesperson.set(salesperson.id, []);
    }
    for (const row of occupied) {
      const items = dbBusyBySalesperson.get(row.salesperson_id) || [];
      items.push({
        startUtc: DateTime.fromJSDate(row.start_at_utc, { zone: "utc" }).toISO() || "",
        endUtc: DateTime.fromJSDate(row.end_at_utc, { zone: "utc" }).toISO() || ""
      });
      dbBusyBySalesperson.set(row.salesperson_id, items);
    }

    const graphBusyBySalesperson = await this.getGraphBusyMap({
      tenantSlug,
      tenantId: tenant.id,
      m365TenantId: tenant.m365_tenant_id,
      salespersons: targetSalespersons.map((s) => ({ id: s.id, graph_user_id: s.graph_user_id })),
      startIso: ctx.dayOpen.toUTC().toISO() || "",
      endIso: ctx.dayEnd.toUTC().toISO() || ""
    });

    const slots = ctx.slots.filter((slot) =>
      targetSalespersons.some((salesperson) => {
        const graphBusy = graphBusyBySalesperson.get(salesperson.id) || [];
        if (this.slotOverlapsBusy(slot, graphBusy, ctx.bufferMinutes)) return false;
        const dbBusy = dbBusyBySalesperson.get(salesperson.id) || [];
        if (this.slotOverlapsBusy(slot, dbBusy, ctx.bufferMinutes)) return false;
        return true;
      })
    );

    this.availabilityCache.set(cacheKey, { expiresAt: Date.now() + 45_000, slots });
    return slots;
  }

  private async isSalespersonGraphBusyForSlot(
    tenantSlug: string,
    tenant: { id: string; m365_tenant_id: string | null },
    salesperson: { id: string; graph_user_id: string },
    startAt: Date,
    endAt: Date,
    bufferMinutes: number
  ) {
    if (process.env.GRAPH_ENABLED === "0") return false;
    if (!tenant.m365_tenant_id || !salesperson.graph_user_id) return false;

    try {
      const busy = await this.graph.getBusySlots(
        tenant.m365_tenant_id,
        salesperson.graph_user_id,
        DateTime.fromJSDate(startAt, { zone: "utc" }).toISO() || "",
        DateTime.fromJSDate(endAt, { zone: "utc" }).toISO() || ""
      );
      const slot: AvailabilitySlot = {
        start_at_utc: DateTime.fromJSDate(startAt, { zone: "utc" }).toISO() || "",
        end_at_utc: DateTime.fromJSDate(endAt, { zone: "utc" }).toISO() || ""
      };
      return this.slotOverlapsBusy(slot, busy, bufferMinutes);
    } catch (e) {
      log("warn", "hold_graph_busy_fetch_failed", {
        tenantSlug,
        tenantId: tenant.id,
        salespersonId: salesperson.id,
        err: e instanceof Error ? e.message : String(e)
      });
      return false;
    }
  }

  private async tryCreateHoldForSalespersonTx(
    tx: Prisma.TransactionClient,
    params: {
      tenantId: string;
      salespersonId: string;
      customerId: string;
      startAt: Date;
      endAt: Date;
      idempotencyKey: string;
      now: Date;
      bookingMode: BookingMode;
      publicNotes: string | null;
    }
  ) {
    const lockKey = `hold:${params.tenantId}:${params.salespersonId}:${params.startAt.toISOString()}:${params.endAt.toISOString()}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

    const slotExisting = await tx.booking.findFirst({
      where: {
        tenant_id: params.tenantId,
        salesperson_id: params.salespersonId,
        start_at_utc: params.startAt,
        end_at_utc: params.endAt
      },
      include: { hold: true }
    });
    if (slotExisting) {
      const holdValid =
        (slotExisting.status === BookingStatus.hold || slotExisting.status === BookingStatus.pending_verify) &&
        !!slotExisting.hold &&
        slotExisting.hold.expires_at_utc > params.now;

      if (slotExisting.status === BookingStatus.confirmed || holdValid) {
        return null;
      }

      return tx.booking.update({
        where: { id: slotExisting.id },
        data: {
          customer_id: params.customerId,
          status: BookingStatus.hold,
          booking_mode: params.bookingMode,
          public_notes: params.publicNotes,
          idempotency_key: params.idempotencyKey,
          verify_token_jti: null,
          hold: {
            upsert: {
              create: {
                expires_at_utc: DateTime.fromJSDate(params.now).plus({ minutes: HOLD_TTL_MINUTES }).toJSDate()
              },
              update: {
                expires_at_utc: DateTime.fromJSDate(params.now).plus({ minutes: HOLD_TTL_MINUTES }).toJSDate()
              }
            }
          }
        } as any,
        include: { hold: true }
      });
    }

    const conflict = await tx.booking.findFirst({
      where: {
        tenant_id: params.tenantId,
        salesperson_id: params.salespersonId,
        start_at_utc: { lt: params.endAt },
        end_at_utc: { gt: params.startAt },
        OR: [
          { status: BookingStatus.confirmed },
          {
            status: { in: [BookingStatus.hold, BookingStatus.pending_verify] },
            hold: { is: { expires_at_utc: { gt: params.now } } }
          }
        ]
      },
      select: { id: true }
    });
    if (conflict) return null;

    return tx.booking.create({
      data: {
        tenant_id: params.tenantId,
        salesperson_id: params.salespersonId,
        customer_id: params.customerId,
        start_at_utc: params.startAt,
        end_at_utc: params.endAt,
        booking_mode: params.bookingMode,
        public_notes: params.publicNotes,
        status: BookingStatus.hold,
        idempotency_key: params.idempotencyKey,
        hold: {
          create: {
            expires_at_utc: DateTime.fromJSDate(params.now).plus({ minutes: HOLD_TTL_MINUTES }).toJSDate()
          }
        }
      } as any,
      include: { hold: true }
    });
  }

  async createHold(
    tenantSlug: string,
    payload: {
      salesperson_id?: string;
      start_at: string;
      end_at: string;
      booking_mode?: string;
      public_notes?: string;
      customer: { email: string; name?: string; company?: string };
    },
    idempotencyKey: string,
    requestId?: string
  ) {
    if (!idempotencyKey) throw new BadRequestException("Idempotency-Key required");
    const tenant = await prisma.tenant.findUnique({ where: { slug: tenantSlug } });
    if (!tenant) throw new NotFoundException("Tenant not found");
    log("info", "hold_requested", { tenantSlug, requestId, salespersonId: payload.salesperson_id ?? null });

    const startAt = parseIsoToUtc(payload.start_at);
    const endAt = parseIsoToUtc(payload.end_at);
    if (endAt <= startAt) throw new BadRequestException("invalid slot range");

    const bookingMode = this.normalizeBookingMode(payload.booking_mode);
    const publicNotes = this.normalizePublicNotes(payload.public_notes);

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

    const availableSalespersons = await prisma.salesperson.findMany({
      where: {
        tenant_id: tenant.id,
        active: true,
        ...(payload.salesperson_id ? { id: payload.salesperson_id } : {})
      },
      orderBy: { display_name: "asc" },
      select: { id: true, display_name: true, timezone: true, graph_user_id: true }
    });

    if (payload.salesperson_id && availableSalespersons.length === 0) {
      throw new NotFoundException("Salesperson not found");
    }
    if (availableSalespersons.length === 0) {
      throw new ConflictException("No active salesperson");
    }

    const { bufferMinutes } = this.parseBusinessHours(tenant);
    const graphBusyIds = new Set<string>();
    for (const salesperson of availableSalespersons) {
      const busy = await this.isSalespersonGraphBusyForSlot(
        tenantSlug,
        { id: tenant.id, m365_tenant_id: tenant.m365_tenant_id },
        { id: salesperson.id, graph_user_id: salesperson.graph_user_id },
        startAt,
        endAt,
        bufferMinutes
      );
      if (busy) graphBusyIds.add(salesperson.id);
    }

    const now = utcNow();
    let booking: any;
    try {
      booking = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`rr:${tenant.id}`}))`;

        const existing = await tx.booking.findFirst({
          where: { tenant_id: tenant.id, idempotency_key: idempotencyKey },
          include: { hold: true }
        });
        if (existing) return existing;

        const ordered = await tx.salesperson.findMany({
          where: {
            tenant_id: tenant.id,
            active: true,
            ...(payload.salesperson_id ? { id: payload.salesperson_id } : {})
          },
          orderBy: { display_name: "asc" },
          select: { id: true, timezone: true }
        });
        if (ordered.length === 0) {
          throw new ConflictException("No active salesperson");
        }

        let startIndex = 0;
        if (!payload.salesperson_id) {
          const t = await tx.tenant.findUnique({
            where: { id: tenant.id },
            select: { rr_cursor: true }
          });
          startIndex = ((t?.rr_cursor ?? 0) % ordered.length + ordered.length) % ordered.length;
        }

        for (let offset = 0; offset < ordered.length; offset += 1) {
          const idx = payload.salesperson_id ? offset : (startIndex + offset) % ordered.length;
          const salesperson = ordered[idx];

          if (graphBusyIds.has(salesperson.id)) {
            continue;
          }

          const created = await this.tryCreateHoldForSalespersonTx(tx, {
            tenantId: tenant.id,
            salespersonId: salesperson.id,
            customerId: customer.id,
            startAt,
            endAt,
            idempotencyKey,
            now,
            bookingMode,
            publicNotes
          });
          if (!created) continue;

          if (!payload.salesperson_id) {
            await tx.tenant.update({
              where: { id: tenant.id },
              data: { rr_cursor: (idx + 1) % ordered.length }
            });
          }
          return created;
        }

        throw new ConflictException("Slot already booked");
      });
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

    const assigned =
      availableSalespersons.find((s) => s.id === booking.salesperson_id) ||
      (await prisma.salesperson.findUnique({
        where: { id: booking.salesperson_id },
        select: { id: true, timezone: true }
      }));
    if (assigned) {
      this.invalidateAvailabilityCacheForStart(tenant.id, assigned.id, assigned.timezone, startAt);
    }

    return booking;
  }

  async sendVerification(tenantSlug: string, bookingId: string, idempotencyKey: string, requestId?: string) {
    if (!idempotencyKey) throw new BadRequestException("Idempotency-Key required");
    const tenant = await prisma.tenant.findUnique({ where: { slug: tenantSlug } });
    if (!tenant) throw new NotFoundException("Tenant not found");
    log("info", "verify_email_requested", { tenantSlug, bookingId, requestId });

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
        const verifyUrl = `${config.baseUrl}/public/${tenantSlug}?token=${encodeURIComponent(token)}`;
        await this.mailSender.send({
          m365TenantId: tenant.m365_tenant_id,
          to: booking.customer.email,
          subject: `Booking verification ${booking.id}`,
          body: `Please verify your booking: ${verifyUrl}`
        });
      } catch (e) {
        log("warn", "verify_email_send_failed", {
          tenantSlug,
          bookingId: booking.id,
          requestId,
          err: e instanceof Error ? e.message : String(e)
        });
      }
    } else {
      log("info", "verify_email_send_skipped", { tenantSlug, bookingId: booking.id, graphEnabled, requestId });
    }


    await this.recordIdempotency(tenant.id, "verify-email", idempotencyKey);

    return { status: "sent", token };
  }

  private async sendConfirmationEmailBestEffort(params: {
    tenantSlug: string;
    tenant: { id: string; m365_tenant_id: string | null; public_location_text?: string | null };
    booking: {
      id: string;
      start_at_utc: Date;
      end_at_utc: Date;
      booking_mode?: string | null;
      customer: { email: string };
      salesperson: { timezone: string };
    };
    zoomJoinUrl: string | null;
  }) {
    if (process.env.GRAPH_ENABLED === "0" || !params.tenant.m365_tenant_id) {
      this.logger.warn(
        `Confirmation email skipped: Graph unavailable for tenant=${params.tenant.id}, booking=${params.booking.id}`
      );
      await prisma.booking.update({
        where: { id: params.booking.id },
        data: { customer_notify_required: true }
      }).catch(() => {});
      return;
    }
    const links = this.buildCustomerActionLinks(
      params.tenantSlug,
      params.booking.id,
      params.tenant.id,
      params.booking.start_at_utc
    );
    const bookingMode: BookingMode = params.booking.booking_mode === "offline" ? "offline" : "online";
    const email = this.buildConfirmationEmail({
      startIsoUtc: toIsoUtc(params.booking.start_at_utc),
      endIsoUtc: toIsoUtc(params.booking.end_at_utc),
      timezone: params.booking.salesperson.timezone || "Asia/Tokyo",
      bookingMode,
      zoomJoinUrl: params.zoomJoinUrl,
      locationText: params.tenant.public_location_text,
      cancelUrl: links.cancelUrl,
      rescheduleUrl: links.rescheduleUrl
    });

    try {
      await this.mailSender.send({
        m365TenantId: params.tenant.m365_tenant_id,
        to: params.booking.customer.email,
        subject: email.subject,
        body: email.body
      });
      await prisma.booking.update({
        where: { id: params.booking.id },
        data: { customer_notify_required: false }
      }).catch(() => {});
    } catch (e) {
      this.logger.warn(
        `Confirmation email failed: tenant=${params.tenant.id}, booking=${params.booking.id}, error=${
          e instanceof Error ? e.message : String(e)
        }`
      );
      await prisma.booking.update({
        where: { id: params.booking.id },
        data: { customer_notify_required: true }
      }).catch(() => {});
    }
  }

  async confirmBooking(tenantSlug: string, token: string, idempotencyKey: string, requestId?: string) {
    if (!idempotencyKey) throw new BadRequestException("Idempotency-Key required");
    const tenant = await prisma.tenant.findUnique({ where: { slug: tenantSlug } });
    if (!tenant) throw new NotFoundException("Tenant not found");
    log("info", "confirm_requested", { tenantSlug, requestId });

    const tokenPayload = this.verifyBookingTokenOrThrow(token, "Hold expired");
    if (tokenPayload.purpose !== "verify") throw new ForbiddenException("Invalid token purpose");

    const existing = await this.checkIdempotency(tenant.id, "confirm", idempotencyKey);
    if (existing) {
      return prisma.booking.findFirst({ where: { id: tokenPayload.booking_id, tenant_id: tenant.id } });
    }

    const booking = await prisma.booking.findFirst({
      where: { id: tokenPayload.booking_id, tenant_id: tenant.id },
      include: { customer: true, salesperson: true, hold: true, graph_event: true }
    });
    if (!booking || !booking.customer || !booking.salesperson) throw new NotFoundException("Booking not found");

    if (booking.verify_token_jti !== tokenPayload.jti) {
      log("warn", "confirm_rejected", {
        tenantSlug,
        requestId,
        bookingId: booking.id,
        bookingStatus: booking.status,
        verifyTokenJti: booking.verify_token_jti,
        tokenJti: tokenPayload.jti,
        holdExpiresAtUtc: booking.hold ? toIsoUtc(booking.hold.expires_at_utc) : null
      });
      throw new ForbiddenException("Token already used");
    }

    if (booking.status === BookingStatus.confirmed) {
      await this.recordIdempotency(tenant.id, "confirm", idempotencyKey);
      return booking;
    }

    if (booking.status !== BookingStatus.pending_verify) {
      log("warn", "confirm_rejected", {
        tenantSlug,
        requestId,
        bookingId: booking.id,
        bookingStatus: booking.status,
        verifyTokenJti: booking.verify_token_jti,
        tokenJti: tokenPayload.jti,
        holdExpiresAtUtc: booking.hold ? toIsoUtc(booking.hold.expires_at_utc) : null
      });
      throw new ConflictException("Invalid booking state");
    }

    if (booking.hold && booking.hold.expires_at_utc <= utcNow()) {
      log("warn", "confirm_rejected", {
        tenantSlug,
        requestId,
        bookingId: booking.id,
        bookingStatus: booking.status,
        verifyTokenJti: booking.verify_token_jti,
        tokenJti: tokenPayload.jti,
        holdExpiresAtUtc: toIsoUtc(booking.hold.expires_at_utc)
      });
      await prisma.booking.update({ where: { id: booking.id }, data: { status: BookingStatus.expired } });
      throw new ConflictException("Hold expired");
    }

    const graphEnabled = process.env.GRAPH_ENABLED !== "0";
    const zoomEnabled = process.env.ZOOM_ENABLED !== "0";
    const graphReady =
      graphEnabled &&
      !!tenant.m365_tenant_id &&
      !!booking.salesperson.graph_user_id &&
      !booking.graph_event;

    const startIso = toIsoUtc(booking.start_at_utc);
    const endIso = toIsoUtc(booking.end_at_utc);

    let zoomMeeting: { meetingId: string; joinUrl: string; startUrl: string } | null = null;
    try {

      if (zoomEnabled) {
          zoomMeeting = await this.zoom.createMeeting({
            topic: this.buildEventSubject(),
            startUtc: startIso,
            endUtc: endIso,
            timezone: booking.salesperson.timezone
          });
        }

        // Graphは有効かつ未作成のときだけ作る（増殖防止）
        let graphEvent: { eventId: string; iCalUId: string; etag: string } | null = null;
        if (graphReady) {
          const body = this.buildEventBody();
          graphEvent = await this.graph.createEvent(tenant.m365_tenant_id || "", {
            organizerUserId: booking.salesperson.graph_user_id,
            subject: this.buildEventSubject(),
            startUtc: startIso,
            endUtc: endIso,
            timezone: booking.salesperson.timezone,
            attendeeEmail: booking.customer.email,
            body,
            transactionId: `booking:${booking.id}`
          });
        }
      const result = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${booking.id}))`;

        const latest = await tx.booking.findFirst({ where: { id: booking.id } });
        if (!latest || latest.status === BookingStatus.confirmed) return latest;

        if (zoomMeeting) {
          await tx.meeting.upsert({
            where: { booking_id: booking.id },
            create: {
              booking_id: booking.id,
              provider: "zoom",
              provider_meeting_id: zoomMeeting.meetingId,
              join_url: zoomMeeting.joinUrl,
              start_url: zoomMeeting.startUrl
            },
            update: {
              provider_meeting_id: zoomMeeting.meetingId,
              join_url: zoomMeeting.joinUrl,
              start_url: zoomMeeting.startUrl
            }
          });
        }

        if (graphEvent) {
            await tx.graphEvent.upsert({
              where: { booking_id: booking.id },
              create: {
                booking_id: booking.id,
                organizer_user_id: booking.salesperson.graph_user_id,
                event_id: graphEvent.eventId,
                iCalUId: graphEvent.iCalUId,
                etag: graphEvent.etag,
                updated_at: utcNow()
              },
              update: {
                organizer_user_id: booking.salesperson.graph_user_id,
                event_id: graphEvent.eventId,
                iCalUId: graphEvent.iCalUId,
                etag: graphEvent.etag,
                updated_at: utcNow()
              }
            });
          }
        const updated = await tx.booking.update({
          where: { id: booking.id },
          data: {
            status: BookingStatus.confirmed,
            verify_token_jti: null
          }
        });
        await this.writePublicConfirmToken(tx, booking.id, null);
        await tx.hold.deleteMany({ where: { booking_id: booking.id } });
        return updated;
      });

      await this.recordIdempotency(tenant.id, "confirm", idempotencyKey);

      const persistedMeeting = await prisma.meeting.findUnique({
        where: { booking_id: booking.id },
        select: { join_url: true }
      });
      await this.sendConfirmationEmailBestEffort({
        tenantSlug,
        tenant,
        booking,
        zoomJoinUrl: persistedMeeting?.join_url ?? null
      });

      return result;
    } catch (err) {
      if (zoomMeeting) {
        const compensationJobId = randomUUID();
        await prisma.$executeRaw`
          INSERT INTO "compensation_jobs" (
            "id",
            "tenant_id",
            "booking_id",
            "status",
            "reason",
            "payload",
            "attempts",
            "created_at",
            "updated_at"
          )
          VALUES (
            ${compensationJobId}::uuid,
            ${tenant.id}::uuid,
            ${booking.id}::uuid,
            'pending',
            'graph_failed_after_zoom',
            ${JSON.stringify({ zoom_meeting_id: zoomMeeting.meetingId })}::jsonb,
            0,
            NOW(),
            NOW()
          )
        `;
        try {
          await this.zoom.deleteMeeting(zoomMeeting.meetingId);
        } catch {

        }
      }
      throw err;
    }
  }

  async cancelBooking(tenantSlug: string, bookingId: string, token: string, idempotencyKey: string, requestId?: string) {
    if (!idempotencyKey) throw new BadRequestException("Idempotency-Key required");
    const tenant = await prisma.tenant.findUnique({ where: { slug: tenantSlug } });
    if (!tenant) throw new NotFoundException("Tenant not found");
    log("info", "cancel_requested", { tenantSlug, bookingId, requestId });

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
        requestId,
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
        requestId,
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
    idempotencyKey: string,
    requestId?: string
  ) {
    if (!idempotencyKey) throw new BadRequestException("Idempotency-Key required");
    const tenant = await prisma.tenant.findUnique({ where: { slug: tenantSlug } });
    if (!tenant) throw new NotFoundException("Tenant not found");
    log("info", "reschedule_requested", { tenantSlug, bookingId, requestId });

    if (!token) throw new BadRequestException("token required");
    const tokenPayload = this.verifyBookingTokenOrThrow(token);
    if (tokenPayload.purpose !== "reschedule") throw new ForbiddenException("Invalid token purpose");
    if (tokenPayload.booking_id !== bookingId) throw new ForbiddenException("Token booking mismatch");
    if (tokenPayload.tenant_id !== tenant.id) throw new ForbiddenException("Token tenant mismatch");

    const booking = await prisma.booking.findFirst({
      where: { id: bookingId, tenant_id: tenant.id },
      include: { salesperson: true, graph_event: true }
    });
    if (!booking) throw new NotFoundException("Booking not found");

    const newStartAt = parseIsoToUtc(payload.new_start_at);
    const newEndAt = parseIsoToUtc(payload.new_end_at);
    if (newEndAt <= newStartAt) throw new BadRequestException("invalid slot range");
    const now = utcNow();

    const existing = await this.checkIdempotency(tenant.id, "reschedule", idempotencyKey);
    if (existing) {
      return {
        status: "rescheduled",
        booking_id: booking.id,
        old_start_at_utc: toIsoUtc(booking.start_at_utc),
        old_end_at_utc: toIsoUtc(booking.end_at_utc),
        new_start_at_utc: toIsoUtc(newStartAt),
        new_end_at_utc: toIsoUtc(newEndAt)
      };
    }

    if (booking.status !== BookingStatus.confirmed) throw new ConflictException("Invalid booking state");

    const deadline = DateTime.fromJSDate(booking.start_at_utc).minus({ hours: CANCEL_DEADLINE_HOURS });
    if (DateTime.utc() > deadline) throw new ConflictException("Reschedule deadline passed");

    const sameAsCurrent =
      booking.start_at_utc.getTime() === newStartAt.getTime() &&
      booking.end_at_utc.getTime() === newEndAt.getTime();
    if (sameAsCurrent) {
      if (booking.customer_reinvite_required && this.canPatchGraphEvent(tenant, booking)) {
        await this.patchGraphEventTimesBestEffort({
          tenantId: tenant.id,
          m365TenantId: tenant.m365_tenant_id || "",
          bookingId: booking.id,
          organizerUserId: booking.graph_event!.organizer_user_id,
          eventId: booking.graph_event!.event_id,
          startUtc: booking.start_at_utc,
          endUtc: booking.end_at_utc,
          action: "reschedule_patch"
        });
      }
      await this.recordIdempotency(tenant.id, "reschedule", idempotencyKey);
      return {
        status: "rescheduled",
        booking_id: booking.id,
        old_start_at_utc: toIsoUtc(booking.start_at_utc),
        old_end_at_utc: toIsoUtc(booking.end_at_utc),
        new_start_at_utc: toIsoUtc(newStartAt),
        new_end_at_utc: toIsoUtc(newEndAt)
      };
    }

    const result = await prisma.$transaction(async (tx) => {

      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${booking.id}))`;

      const latest = await tx.booking.findFirst({ where: { id: booking.id } });
      if (!latest) throw new NotFoundException("Booking not found");
      if (latest.status !== BookingStatus.confirmed) throw new ConflictException("Invalid booking state");

      const latestSameAsCurrent =
        latest.start_at_utc.getTime() === newStartAt.getTime() &&
        latest.end_at_utc.getTime() === newEndAt.getTime();
      if (latestSameAsCurrent) {
        return {
          bookingId: latest.id,
          oldStartAtUtc: latest.start_at_utc,
          oldEndAtUtc: latest.end_at_utc,
          newStartAtUtc: latest.start_at_utc,
          newEndAtUtc: latest.end_at_utc
        };
      }

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

      const oldStartAtUtc = latest.start_at_utc;
      const oldEndAtUtc = latest.end_at_utc;

      await tx.booking.update({
        where: { id: latest.id },
        data: {
          start_at_utc: newStartAt,
          end_at_utc: newEndAt
        }
      });

      await tx.trackingEvent.create({
        data: {
          tenant_id: latest.tenant_id,
          booking_id: latest.id,
          type: "booking.rescheduled",
          occurred_at_utc: now,
          meta_json: {
            old_start_at_utc: toIsoUtc(oldStartAtUtc),
            old_end_at_utc: toIsoUtc(oldEndAtUtc),
            new_start_at_utc: toIsoUtc(newStartAt),
            new_end_at_utc: toIsoUtc(newEndAt),
            by: "public_token"
          }
        }
      });

      return {
        bookingId: latest.id,
        oldStartAtUtc,
        oldEndAtUtc,
        newStartAtUtc: newStartAt,
        newEndAtUtc: newEndAt
      };
    });

    await this.recordIdempotency(tenant.id, "reschedule", idempotencyKey);

    if (this.canPatchGraphEvent(tenant, booking)) {
      await this.patchGraphEventTimesBestEffort({
        tenantId: tenant.id,
        m365TenantId: tenant.m365_tenant_id || "",
        bookingId: booking.id,
        organizerUserId: booking.graph_event!.organizer_user_id,
        eventId: booking.graph_event!.event_id,
        startUtc: newStartAt,
        endUtc: newEndAt,
        action: "reschedule_patch"
      });
    }

    const tz = booking.salesperson?.timezone ?? "utc";
    this.invalidateAvailabilityCacheForStart(tenant.id, booking.salesperson_id, tz, booking.start_at_utc);
    this.invalidateAvailabilityCacheForStart(tenant.id, booking.salesperson_id, tz, newStartAt);

    return {
      status: "rescheduled",
      booking_id: result.bookingId,
      old_start_at_utc: toIsoUtc(result.oldStartAtUtc),
      old_end_at_utc: toIsoUtc(result.oldEndAtUtc),
      new_start_at_utc: toIsoUtc(result.newStartAtUtc),
      new_end_at_utc: toIsoUtc(result.newEndAtUtc)
    };
  }

  async reinviteBookingInternal(tenantSlug: string, bookingId: string) {
    const tenant = await prisma.tenant.findUnique({
      where: { slug: tenantSlug },
      select: { id: true, m365_tenant_id: true }
    });
    if (!tenant) throw new NotFoundException("Tenant not found");

    const booking = await prisma.booking.findFirst({
      where: { id: bookingId, tenant_id: tenant.id },
      include: { graph_event: true }
    });
    if (!booking) throw new NotFoundException("Booking not found");
    if (process.env.GRAPH_ENABLED === "0") {
      throw new BadRequestException("Graph is disabled");
    }
    if (!tenant.m365_tenant_id) {
      throw new BadRequestException("Tenant Microsoft Graph is not configured");
    }
    if (!booking.graph_event?.organizer_user_id || !booking.graph_event?.event_id) {
      throw new BadRequestException("Graph event is not available");
    }

    const bodyText = "=== BookingMVP Sync ===\nThis event was re-synced from booking system.\n";

    try {
      const patched = await this.graph.updateEventBody(
        tenant.m365_tenant_id,
        booking.graph_event.organizer_user_id,
        booking.graph_event.event_id,
        { bodyText }
      );
      await prisma.$transaction(async (tx) => {
        await tx.graphEvent.update({
          where: { booking_id: booking.id },
          data: {
            etag: patched.etag,
            updated_at: utcNow()
          }
        });
        await tx.booking.update({
          where: { id: booking.id },
          data: { customer_reinvite_required: false }
        });
        await tx.trackingEvent.create({
          data: {
            tenant_id: tenant.id,
            booking_id: booking.id,
            type: "booking.reinvited",
            occurred_at_utc: utcNow(),
            meta_json: {
              by: "internal_api",
              booking_id: booking.id,
              organizer_user_id: booking.graph_event!.organizer_user_id,
              event_id: booking.graph_event!.event_id
            }
          }
        });
      });
      return { ok: true };
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      log("warn", "graph_patch_failed", {
        action: "reinvite_body",
        bookingId: booking.id,
        organizerUserId: booking.graph_event.organizer_user_id,
        eventId: booking.graph_event.event_id,
        err
      });
      await prisma.$transaction(async (tx) => {
        await tx.booking.update({
          where: { id: booking.id },
          data: { customer_reinvite_required: true }
        });
        await tx.trackingEvent.create({
          data: {
            tenant_id: tenant.id,
            booking_id: booking.id,
            type: "graph.patch_failed",
            occurred_at_utc: utcNow(),
            meta_json: {
              action: "reinvite_body",
              booking_id: booking.id,
              organizer_user_id: booking.graph_event!.organizer_user_id,
              event_id: booking.graph_event!.event_id,
              error: err
            }
          }
        });
      });
      throw new BadRequestException(`Graph body patch failed: ${err}`);
    }
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

  async listBookingsInternal(
    tenantSlug: string,
    params: ListBookingsInternalParams = {}
  ): Promise<InternalBookingListItem[]> {
    const tenant = await prisma.tenant.findUnique({
      where: { slug: tenantSlug },
      select: { id: true }
    });
    if (!tenant) throw new NotFoundException("Tenant not found");

    const fromUtc = this.parseInternalDateParam(params.from, "from");
    const toUtc = this.parseInternalDateParam(params.to, "to");
    if (fromUtc && toUtc && fromUtc > toUtc) {
      throw new BadRequestException("from must be less than or equal to to");
    }
    const take = this.parseInternalLimit(params.limit);

    const startAtUtcFilter: Prisma.DateTimeFilter = {};
    if (fromUtc) startAtUtcFilter.gte = fromUtc;
    if (toUtc) startAtUtcFilter.lte = toUtc;

    const rows: any[] = await prisma.booking.findMany({
      where: {
        tenant_id: tenant.id,
        ...(fromUtc || toUtc ? { start_at_utc: startAtUtcFilter } : {})
      },
      orderBy: { start_at_utc: "asc" },
      take,
      select: {
        id: true,
        status: true,
        start_at_utc: true,
        end_at_utc: true,
        booking_mode: true,
        public_notes: true,
        customer: {
          select: {
            email: true,
            name: true,
            company: true
          }
        },
        salesperson: {
          select: {
            display_name: true,
            timezone: true
          }
        },
        meeting: {
          select: {
            provider: true,
            join_url: true
          }
        }
      }
    } as any);

    const baseItems: InternalBookingListItem[] = rows.map((row) => ({
      id: row.id,
      status: row.status,
      start_at_utc: toIsoUtc(row.start_at_utc),
      end_at_utc: toIsoUtc(row.end_at_utc),
      booking_mode: row.booking_mode,
      public_notes: row.public_notes,
      customer: {
        email: row.customer.email,
        name: row.customer.name,
        company: row.customer.company
      },
      salesperson: {
        display_name: row.salesperson.display_name,
        timezone: row.salesperson.timezone
      },
      meeting: row.meeting
        ? {
            provider: row.meeting.provider,
            ...(row.meeting.join_url ? { join_url: row.meeting.join_url } : {})
          }
        : null
    }));

    if (!params.includeEvents) {
      return baseItems;
    }

    const bookingIds = baseItems.map((item) => item.id);
    if (bookingIds.length === 0) {
      return baseItems.map((item) => ({ ...item, events: [] }));
    }

    const events: any[] = await prisma.trackingEvent.findMany({
      where: {
        tenant_id: tenant.id,
        booking_id: { in: bookingIds }
      },
      orderBy: { occurred_at_utc: "asc" },
      select: {
        booking_id: true,
        type: true,
        occurred_at_utc: true,
        meta_json: true
      }
    } as any);

    const eventsByBooking = new Map<string, InternalBookingEvent[]>();
    for (const event of events) {
      const list = eventsByBooking.get(event.booking_id) || [];
      list.push({
        type: event.type,
        occurred_at_utc: toIsoUtc(event.occurred_at_utc),
        meta_json: event.meta_json
      });
      eventsByBooking.set(event.booking_id, list);
    }

    return baseItems.map((item) => ({
      ...item,
      events: eventsByBooking.get(item.id) || []
    }));
  }

  async resendConfirmationEmails(tenantSlug: string, limit: number) {
    const tenant = await prisma.tenant.findUnique({
      where: { slug: tenantSlug },
      select: { id: true, m365_tenant_id: true, public_location_text: true }
    });
    if (!tenant) throw new NotFoundException("Tenant not found");

    const take = Math.max(1, Math.min(500, Math.floor(limit || 50)));
    const bookings = await prisma.booking.findMany({
      where: {
        tenant_id: tenant.id,
        status: BookingStatus.confirmed,
        customer_notify_required: true
      },
      orderBy: { start_at_utc: "asc" },
      take,
      include: {
        customer: true,
        salesperson: true,
        meeting: true
      }
    });

    let processed = 0;
    for (const booking of bookings) {
      if (!booking.customer || !booking.salesperson) continue;
      await this.sendConfirmationEmailBestEffort({
        tenantSlug,
        tenant,
        booking,
        zoomJoinUrl: booking.meeting?.join_url ?? null
      });
      processed += 1;
    }

    return { processed };
  }

  async expireHolds() {
    const now = utcNow();
    const expired = await prisma.booking.findMany({
      where: {
        status: { in: [BookingStatus.hold, BookingStatus.pending_verify] },
        hold: { is: { expires_at_utc: { lt: now } } }
      },
      select: { id: true }
    });
    const ids = expired.map((b) => b.id);
    if (ids.length === 0) {
      return { expiredBookings: 0, deletedHolds: 0 };
    }

    const [bookingRes, holdRes] = await prisma.$transaction([
      prisma.booking.updateMany({
        where: { id: { in: ids }, status: { in: [BookingStatus.hold, BookingStatus.pending_verify] } },
        data: { status: BookingStatus.expired }
      }),
      prisma.hold.deleteMany({
        where: { booking_id: { in: ids } }
      })
    ]);

    this.availabilityCache.clear();
    return { expiredBookings: bookingRes.count, deletedHolds: holdRes.count };
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
