import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Query,
  UnauthorizedException
} from "@nestjs/common";
import { BookingService } from "./services/booking.service";
import { config } from "./config";

@Controller("v1/internal")
export class InternalController {
  constructor(@Inject(BookingService) private readonly bookingService: BookingService) {}

  private assertAdminApiKey(apiKey: string | undefined) {
    if (!config.adminApiKey || config.adminApiKey === "change-me") {
      throw new UnauthorizedException("Admin API key is not configured");
    }
    if (!apiKey || apiKey !== config.adminApiKey) {
      throw new UnauthorizedException("Invalid API key");
    }
  }

  @Get(":tenantSlug/bookings")
  async listBookings(
    @Param("tenantSlug") tenantSlug: string,
    @Headers("x-admin-api-key") apiKey: string | undefined,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("limit") limit?: string,
    @Query("include_events") includeEvents?: string
  ) {
    this.assertAdminApiKey(apiKey);
    const parsedLimit = limit !== undefined ? Number(limit) : undefined;
    if (parsedLimit !== undefined && !Number.isFinite(parsedLimit)) {
      throw new BadRequestException("limit must be a number");
    }
    return this.bookingService.listBookingsInternal(tenantSlug, {
      from,
      to,
      limit: parsedLimit,
      includeEvents: includeEvents === "1"
    });
  }
  @Get(":tenantSlug/bookings/:bookingId/links")
  async bookingLinks(
    @Param("tenantSlug") tenantSlug: string,
    @Param("bookingId") bookingId: string,
    @Headers("x-admin-api-key") apiKey: string | undefined
  ) {
    this.assertAdminApiKey(apiKey);
    return this.bookingService.buildCustomerLinksInternal(tenantSlug, bookingId);
  }

  @Post(":tenantSlug/bookings/:bookingId/reinvite")
  async reinvite(
    @Param("tenantSlug") tenantSlug: string,
    @Param("bookingId") bookingId: string,
    @Headers("x-admin-api-key") apiKey: string | undefined
  ) {
    this.assertAdminApiKey(apiKey);
    return this.bookingService.reinviteBookingInternal(tenantSlug, bookingId);
  }

  @Post("attendance/:bookingId")
  async attendance(
    @Param("bookingId") bookingId: string,
    @Headers("x-admin-api-key") apiKey: string | undefined,
    @Headers("X-Tenant-Id") tenantId: string | undefined,
    @Body() body: { status: "attended" | "no_show" }
  ) {
    this.assertAdminApiKey(apiKey);
    if (!tenantId) throw new BadRequestException("X-Tenant-Id required");
    return this.bookingService.recordAttendance(bookingId, tenantId, body.status);
  }
}
