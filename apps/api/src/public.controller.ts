import { Body, Controller, Get, Headers, Param, Post, Query } from "@nestjs/common";
import { BookingService } from "./services/booking.service";

@Controller("/v1/public")
export class PublicController {
  constructor(private readonly bookingService: BookingService) {}

  @Get(":tenantSlug/availability")
  async availability(
    @Param("tenantSlug") tenantSlug: string,
    @Query("salesperson") salespersonId: string,
    @Query("date") date: string
  ) {
    return this.bookingService.getAvailability(tenantSlug, salespersonId, date);
  }

  @Post(":tenantSlug/holds")
  async createHold(
    @Param("tenantSlug") tenantSlug: string,
    @Headers("Idempotency-Key") idempotencyKey: string,
    @Body() body: {
      salesperson_id: string;
      start_at: string;
      end_at: string;
      customer: { email: string; name?: string; company?: string };
    }
  ) {
    return this.bookingService.createHold(tenantSlug, body, idempotencyKey);
  }

  @Post(":tenantSlug/auth/verify-email")
  async verifyEmail(
    @Param("tenantSlug") tenantSlug: string,
    @Headers("Idempotency-Key") idempotencyKey: string,
    @Body() body: { booking_id: string }
  ) {
    return this.bookingService.sendVerification(tenantSlug, body.booking_id, idempotencyKey);
  }

  @Post(":tenantSlug/confirm")
  async confirm(
    @Param("tenantSlug") tenantSlug: string,
    @Headers("Idempotency-Key") idempotencyKey: string,
    @Body() body: { token: string }
  ) {
    return this.bookingService.confirmBooking(tenantSlug, body.token, idempotencyKey);
  }

  @Post(":tenantSlug/bookings/:id/cancel")
  async cancel(
    @Param("tenantSlug") tenantSlug: string,
    @Param("id") bookingId: string,
    @Headers("Idempotency-Key") idempotencyKey: string,
    @Body() body: { token: string }
  ) {
    return this.bookingService.cancelBooking(tenantSlug, bookingId, body.token, idempotencyKey);
  }

  @Post(":tenantSlug/bookings/:id/reschedule")
  async reschedule(
    @Param("tenantSlug") tenantSlug: string,
    @Param("id") bookingId: string,
    @Headers("Idempotency-Key") idempotencyKey: string,
    @Body() body: { token: string; new_start_at: string; new_end_at: string }
  ) {
    return this.bookingService.rescheduleBooking(tenantSlug, bookingId, body.token, {
      new_start_at: body.new_start_at,
      new_end_at: body.new_end_at
    }, idempotencyKey);
  }
}
