import { ArgumentMetadata, BadRequestException, ValidationPipe } from "@nestjs/common";
import { PublicController } from "../src/public.controller";
import { AvailabilityQueryDto } from "../src/dto/public/availability.query.dto";
import { CreateHoldDto } from "../src/dto/public/create-hold.dto";
import { VerifyEmailDto } from "../src/dto/public/verify-email.dto";
import { ConfirmDto } from "../src/dto/public/confirm.dto";
import { ConfirmByIdDto } from "../src/dto/public/confirm-by-id.dto";
import { RescheduleBookingDto } from "../src/dto/public/reschedule-booking.dto";
import { requestIdMiddleware } from "../src/middleware/request-id.middleware";

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true
});

const metaFor = (metatype: unknown, type: ArgumentMetadata["type"] = "body"): ArgumentMetadata => ({
  type,
  metatype: metatype as any,
  data: undefined
});

describe("PublicController validation boundary", () => {
  test("holds rejects invalid email", async () => {
    await expect(
      pipe.transform(
        {
          start_at: "2026-03-01T10:00:00.000Z",
          end_at: "2026-03-01T11:00:00.000Z",
          customer: { email: "not-an-email" }
        },
        metaFor(CreateHoldDto)
      )
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  test("holds rejects non-whitelisted field", async () => {
    await expect(
      pipe.transform(
        {
          start_at: "2026-03-01T10:00:00.000Z",
          end_at: "2026-03-01T11:00:00.000Z",
          customer: { email: "user@example.com" },
          unexpected: "value"
        },
        metaFor(CreateHoldDto)
      )
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  test("verify-email rejects missing booking_id", async () => {
    await expect(pipe.transform({}, metaFor(VerifyEmailDto))).rejects.toBeInstanceOf(BadRequestException);
  });

  test("confirm rejects missing token", async () => {
    await expect(pipe.transform({}, metaFor(ConfirmDto))).rejects.toBeInstanceOf(BadRequestException);
  });

  test("confirm rejects booking_id explicitly in controller", async () => {
    const serviceMock = {
      getAvailabilityPublic: jest.fn(),
      listSalespersonsPublic: jest.fn(),
      createHoldPublic: jest.fn(),
      sendVerificationPublic: jest.fn(),
      confirmBookingPublic: jest.fn(),
      confirmBookingPublicById: jest.fn(),
      cancelBookingPublic: jest.fn(),
      rescheduleBookingPublic: jest.fn()
    };
    const controller = new PublicController(serviceMock as any);

    await expect(
      controller.confirm(
        { requestId: "req-1" } as any,
        "acme",
        "idem-1",
        { token: "token-1", booking_id: "legacy-id" }
      )
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(serviceMock.confirmBookingPublic).not.toHaveBeenCalled();
  });

  test("confirm-by-id rejects invalid uuid", async () => {
    await expect(
      pipe.transform({ booking_id: "bad-id", token: "token-1" }, metaFor(ConfirmByIdDto))
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  test("reschedule rejects invalid datetime", async () => {
    await expect(
      pipe.transform(
        {
          token: "token-1",
          new_start_at: "not-datetime",
          new_end_at: "2026-03-01T11:00:00.000Z"
        },
        metaFor(RescheduleBookingDto)
      )
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  test("availability rejects invalid date format", async () => {
    await expect(
      pipe.transform({ date: "2026/03/01" }, metaFor(AvailabilityQueryDto, "query"))
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe("request-id middleware", () => {
  test("returns same x-request-id when provided", () => {
    const req = { headers: { "x-request-id": "req-fixed-123" } } as any;
    const res = { setHeader: jest.fn() } as any;
    const next = jest.fn();

    requestIdMiddleware(req, res, next);

    expect(req.requestId).toBe("req-fixed-123");
    expect(res.setHeader).toHaveBeenCalledWith("x-request-id", "req-fixed-123");
    expect(next).toHaveBeenCalled();
  });

  test("returns generated x-request-id when not provided", () => {
    const req = { headers: {} } as any;
    const res = { setHeader: jest.fn() } as any;
    const next = jest.fn();

    requestIdMiddleware(req, res, next);

    expect(req.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(res.setHeader).toHaveBeenCalledWith("x-request-id", req.requestId);
    expect(next).toHaveBeenCalled();
  });
});
