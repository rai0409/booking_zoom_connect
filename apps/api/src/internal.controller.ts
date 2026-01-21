import { Body, Controller, Headers, Param, Post, ForbiddenException, BadRequestException } from "@nestjs/common";
import { BookingService } from "./services/booking.service";
import { config } from "./config";

@Controller("/v1/internal")
export class InternalController {
  constructor(private readonly bookingService: BookingService) {}

  @Post("/attendance/:bookingId")
  async attendance(
    @Param("bookingId") bookingId: string,
    @Headers("X-Admin-Api-Key") apiKey: string,
    @Headers("X-Tenant-Id") tenantId: string | undefined,
    @Body() body: { status: "attended" | "no_show" }
  ) {
    if (!apiKey || apiKey !== config.adminApiKey) {
      throw new ForbiddenException("Invalid API key");
    }
    if (!tenantId) throw new BadRequestException("X-Tenant-Id required");
    return this.bookingService.recordAttendance(bookingId, tenantId, body.status);
  }
}
