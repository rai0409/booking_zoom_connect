import { Body, Controller, Get, Headers, Inject, Param, Post, Query, BadRequestException } from "@nestjs/common";
import { BookingService } from "./services/booking.service";

@Controller("/v1/public")
export class PublicController {
  constructor(@Inject(BookingService) private readonly bookingService: BookingService) {}

  @Get(":tenantSlug/availability")
  async availability(
    @Param("tenantSlug") tenantSlug: string,
    @Query("salesperson") salespersonId: string | undefined,
    @Query("date") date: string
  ) {
    return this.bookingService.getAvailabilityPublic(tenantSlug, salespersonId, date);
  }

  @Get(":tenantSlug/salespersons")
  async salespersons(@Param("tenantSlug") tenantSlug: string) {
    return this.bookingService.listSalespersonsPublic(tenantSlug);
  }

  @Post(":tenantSlug/holds")
  async createHold(
    @Param("tenantSlug") tenantSlug: string,
    @Headers("Idempotency-Key") idempotencyKey: string,
    @Body() body: {
      salesperson_id?: string;
      start_at: string;
      end_at: string;
      booking_mode?: string;
      public_notes?: string;
      customer: { email: string; name?: string; company?: string };
    }
  ) {
    return this.bookingService.createHoldPublic(tenantSlug, body, idempotencyKey);
  }

  @Post(":tenantSlug/auth/verify-email")
  async verifyEmail(
    @Param("tenantSlug") tenantSlug: string,
    @Headers("Idempotency-Key") idempotencyKey: string,
    @Body() body: { booking_id: string }
  ) {
    return this.bookingService.sendVerificationPublic(tenantSlug, body.booking_id, idempotencyKey);
  }

  @Post(":tenantSlug/confirm")
  async confirm(
    @Param("tenantSlug") tenantSlug: string,
    @Headers("Idempotency-Key") idempotencyKey: string,
    @Body() body: { token?: string; booking_id?: string }
  ) {
    if (body.booking_id) {
      throw new BadRequestException("token required (booking_id confirm is not supported)");
    }
    if (!body.token) {
      throw new BadRequestException("token required");
    }
    return this.bookingService.confirmBookingPublic(tenantSlug, body.token, idempotencyKey);
  }

  @Post(":tenantSlug/confirm-by-id")
  async confirmById(
    @Param("tenantSlug") tenantSlug: string,
    @Headers("Idempotency-Key") idempotencyKey: string,
    @Body() body: { booking_id: string; token: string }
  ) {
    return this.bookingService.confirmBookingPublicById(tenantSlug, body.booking_id, body.token, idempotencyKey);
  }

  @Post(":tenantSlug/bookings/:id/cancel")
  async cancel(
    @Param("tenantSlug") tenantSlug: string,
    @Param("id") bookingId: string,
    @Headers("Idempotency-Key") idempotencyKey: string,
    @Body() body: { token: string }
  ) {
    return this.bookingService.cancelBookingPublic(tenantSlug, bookingId, body.token, idempotencyKey);
  }

  @Post(":tenantSlug/bookings/:id/reschedule")
  async reschedule(
    @Param("tenantSlug") tenantSlug: string,
    @Param("id") bookingId: string,
    @Headers("Idempotency-Key") idempotencyKey: string,
    @Body() body: { token: string; new_start_at: string; new_end_at: string }
  ) {
    return this.bookingService.rescheduleBookingPublic(tenantSlug, bookingId, body.token, {
      new_start_at: body.new_start_at,
      new_end_at: body.new_end_at
    }, idempotencyKey);
  }
}
