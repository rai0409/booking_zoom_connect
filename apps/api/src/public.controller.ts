import { BadRequestException, Body, Controller, Get, Headers, HttpException, Inject, Param, Post, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { BookingService } from "./services/booking.service";
import { AvailabilityQueryDto } from "./dto/public/availability.query.dto";
import { CreateHoldDto } from "./dto/public/create-hold.dto";
import { VerifyEmailDto } from "./dto/public/verify-email.dto";
import { ConfirmDto } from "./dto/public/confirm.dto";
import { ConfirmByIdDto } from "./dto/public/confirm-by-id.dto";
import { CancelBookingDto } from "./dto/public/cancel-booking.dto";
import { RescheduleBookingDto } from "./dto/public/reschedule-booking.dto";
import { log } from "./utils/logger";
import type { RequestWithId } from "./middleware/request-id.middleware";

type PublicConfirmResponse = {
  status: string;
  booking_id: string;
  cancel_url: string;
  reschedule_url: string;
};

@Controller("/v1/public")
export class PublicController {
  constructor(@Inject(BookingService) private readonly bookingService: BookingService) {}

  private extractExceptionMessage(error: HttpException): string {
    const response = error.getResponse();
    if (typeof response === "string") return response;
    if (typeof response === "object" && response !== null) {
      const message = (response as { message?: unknown }).message;
      if (Array.isArray(message)) return String(message[0] ?? error.message);
      if (typeof message === "string") return message;
    }
    return error.message;
  }

  private classifyConfirmErrorCode(status: number, message: string): "HOLD_EXPIRED" | "INVALID_TOKEN" | "INTERNAL_ERROR" {
    const normalized = message.toLowerCase();
    if (normalized.includes("hold expired")) return "HOLD_EXPIRED";
    if (
      status === 401 ||
      status === 403 ||
      normalized.includes("token") ||
      normalized.includes("invalid token") ||
      normalized.includes("token required")
    ) {
      return "INVALID_TOKEN";
    }
    return "INTERNAL_ERROR";
  }

  @Get(":tenantSlug/availability")
  async availability(
    @Req() req: Request,
    @Param("tenantSlug") tenantSlug: string,
    @Query() query: AvailabilityQueryDto
  ) {
    const requestId = (req as RequestWithId).requestId;
    log("info", "public_availability_request", { tenantSlug, requestId, salespersonId: query.salesperson, date: query.date });
    return this.bookingService.getAvailabilityPublic(tenantSlug, query.salesperson, query.date, requestId);
  }

  @Get(":tenantSlug/salespersons")
  async salespersons(@Param("tenantSlug") tenantSlug: string) {
    return this.bookingService.listSalespersonsPublic(tenantSlug);
  }

  @Post(":tenantSlug/holds")
  async createHold(
    @Req() req: Request,
    @Param("tenantSlug") tenantSlug: string,
    @Headers("Idempotency-Key") idempotencyKey: string,
    @Body() body: CreateHoldDto
  ) {
    const requestId = (req as RequestWithId).requestId;
    log("info", "public_hold_request", { tenantSlug, requestId });
    return this.bookingService.createHoldPublic(tenantSlug, body, idempotencyKey, requestId);
  }

  @Post(":tenantSlug/auth/verify-email")
  async verifyEmail(
    @Req() req: Request,
    @Param("tenantSlug") tenantSlug: string,
    @Headers("Idempotency-Key") idempotencyKey: string,
    @Body() body: VerifyEmailDto
  ) {
    const requestId = (req as RequestWithId).requestId;
    log("info", "public_verify_email_request", { tenantSlug, requestId, bookingId: body.booking_id });
    return this.bookingService.sendVerificationPublic(tenantSlug, body.booking_id, idempotencyKey, requestId);
  }

  @Post(":tenantSlug/confirm")
  async confirm(
    @Req() req: Request,
    @Param("tenantSlug") tenantSlug: string,
    @Headers("Idempotency-Key") idempotencyKey: string,
    @Body() body: ConfirmDto
  ): Promise<PublicConfirmResponse> {
    const requestId = (req as RequestWithId).requestId;
    log("info", "public_confirm_request", { tenantSlug, requestId });
    if (body.booking_id !== undefined) {
      throw new BadRequestException("token required (booking_id confirm is not supported)");
    }
    try {
      return await this.bookingService.confirmBookingPublic(tenantSlug, body.token, idempotencyKey, requestId);
    } catch (error) {
      if (error instanceof HttpException) {
        const message = this.extractExceptionMessage(error);
        const status = error.getStatus();
        const code = this.classifyConfirmErrorCode(status, message);
        log("warn", "public_confirm_failed", { tenantSlug, requestId, status, message, code });
        throw new HttpException({ message, code }, status);
      }
      log("error", "public_confirm_failed", {
        tenantSlug,
        requestId,
        status: 500,
        message: error instanceof Error ? error.message : String(error),
        code: "INTERNAL_ERROR"
      });
      throw new HttpException({ message: "Internal server error", code: "INTERNAL_ERROR" }, 500);
    }
  }

  @Post(":tenantSlug/confirm-by-id")
  async confirmById(
    @Req() req: Request,
    @Param("tenantSlug") tenantSlug: string,
    @Headers("Idempotency-Key") idempotencyKey: string,
    @Body() body: ConfirmByIdDto
  ) {
    const requestId = (req as RequestWithId).requestId;
    log("info", "public_confirm_by_id_request", { tenantSlug, requestId, bookingId: body.booking_id });
    return this.bookingService.confirmBookingPublicById(tenantSlug, body.booking_id, body.token, idempotencyKey, requestId);
  }

  @Post(":tenantSlug/bookings/:id/cancel")
  async cancel(
    @Req() req: Request,
    @Param("tenantSlug") tenantSlug: string,
    @Param("id") bookingId: string,
    @Headers("Idempotency-Key") idempotencyKey: string,
    @Body() body: CancelBookingDto
  ) {
    const requestId = (req as RequestWithId).requestId;
    log("info", "public_cancel_request", { tenantSlug, requestId, bookingId });
    return this.bookingService.cancelBookingPublic(tenantSlug, bookingId, body.token, idempotencyKey, requestId);
  }

  @Post(":tenantSlug/bookings/:id/reschedule")
  async reschedule(
    @Req() req: Request,
    @Param("tenantSlug") tenantSlug: string,
    @Param("id") bookingId: string,
    @Headers("Idempotency-Key") idempotencyKey: string,
    @Body() body: RescheduleBookingDto
  ) {
    const requestId = (req as RequestWithId).requestId;
    log("info", "public_reschedule_request", { tenantSlug, requestId, bookingId });
    return this.bookingService.rescheduleBookingPublic(tenantSlug, bookingId, body.token, {
      new_start_at: body.new_start_at,
      new_end_at: body.new_end_at
    }, idempotencyKey, requestId);
  }
}
