import { DateTime } from "luxon";
import { z } from "zod";

const JST_ZONE = "Asia/Tokyo";

function isExistingYmd(value: string): boolean {
  const dt = DateTime.fromFormat(value, "yyyy-LL-dd", { zone: JST_ZONE });
  return dt.isValid && dt.toFormat("yyyy-LL-dd") === value;
}

function isValidUtcIso(value: string): boolean {
  return DateTime.fromISO(value, { zone: "utc" }).isValid;
}

export const BookingModeSchema = z.enum(["online", "offline"]);

export const YmdSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(isExistingYmd, { message: "date must be a real calendar date" });

export const IsoUtcDateTimeSchema = z
  .string()
  .datetime({ offset: true })
  .refine(isValidUtcIso, { message: "invalid UTC datetime" });

export const SlotSchema = z
  .object({
    start_at_utc: IsoUtcDateTimeSchema,
    end_at_utc: IsoUtcDateTimeSchema
  })
  .superRefine((value, ctx) => {
    const start = DateTime.fromISO(value.start_at_utc, { zone: "utc" });
    const end = DateTime.fromISO(value.end_at_utc, { zone: "utc" });
    if (start >= end) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "start_at_utc must be earlier than end_at_utc",
        path: ["end_at_utc"]
      });
    }
  });

const SalespersonRawSchema = z.object({
  id: z.string().min(1),
  display_name: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  timezone: z.string().nullable().optional()
});

export const SalespersonSchema = SalespersonRawSchema.transform((raw) => ({
  id: raw.id,
  display_name: raw.display_name ?? raw.name ?? "",
  timezone: raw.timezone ?? undefined
})).refine((value) => value.display_name.length > 0, {
  message: "salesperson display_name is required"
});

const HoldResponseRawSchema = z
  .object({
    id: z.string().min(1).optional(),
    booking_id: z.string().min(1).optional(),
    status: z.string().min(1),
    start_at_utc: IsoUtcDateTimeSchema,
    end_at_utc: IsoUtcDateTimeSchema,
    hold: z
      .object({
        expires_at_utc: IsoUtcDateTimeSchema
      })
      .nullable()
      .optional()
  })
  .passthrough();

export const HoldResponseSchema = HoldResponseRawSchema.transform((raw) => {
  const canonicalId = raw.id ?? raw.booking_id;

  return {
    id: canonicalId ?? "",
    status: raw.status,
    start_at_utc: raw.start_at_utc,
    end_at_utc: raw.end_at_utc,
    hold: raw.hold ?? null
  };
}).refine((value) => value.id.length > 0, {
  message: "hold response requires id or booking_id"
});

export const VerifyEmailResponseSchema = z
  .object({
    status: z.string().min(1),
    token: z.string().optional()
  })
  .passthrough();

export const ConfirmResponseSchema = z
  .object({
    status: z.string().min(1),
    booking_id: z.string().min(1).optional(),
    cancel_url: z.string().url().optional(),
    reschedule_url: z.string().url().optional()
  })
  .passthrough();

export const CancelResponseSchema = z
  .object({
    status: z.string().min(1)
  })
  .passthrough();

export const RescheduleResponseSchema = z
  .object({
    status: z.string().min(1),
    booking_id: z.string().min(1).optional(),
    old_start_at_utc: IsoUtcDateTimeSchema.optional(),
    old_end_at_utc: IsoUtcDateTimeSchema.optional(),
    new_start_at_utc: IsoUtcDateTimeSchema.optional(),
    new_end_at_utc: IsoUtcDateTimeSchema.optional()
  })
  .passthrough();

export const PublicApiErrorSchema = z
  .object({
    message: z.union([z.string(), z.array(z.string())]).optional(),
    error: z.string().optional(),
    code: z.string().optional()
  })
  .passthrough();

export const BookRouteInputSchema = z
  .object({
    tenantSlug: z.string().trim().min(1).max(120),
    date: YmdSchema,
    customerName: z.string().trim().min(1).max(120),
    customerEmail: z
      .string()
      .trim()
      .email()
      .max(320)
      .transform((value) => value.toLowerCase()),
    bookingMode: BookingModeSchema,
    publicNotes: z.string().max(500),
    start_at_utc: IsoUtcDateTimeSchema,
    end_at_utc: IsoUtcDateTimeSchema
  })
  .superRefine((value, ctx) => {
    const start = DateTime.fromISO(value.start_at_utc, { zone: "utc" });
    const end = DateTime.fromISO(value.end_at_utc, { zone: "utc" });

    if (start >= end) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "slot range is invalid",
        path: ["end_at_utc"]
      });
    }
  });

export type BookingMode = z.infer<typeof BookingModeSchema>;
export type Slot = z.infer<typeof SlotSchema>;
export type Salesperson = z.infer<typeof SalespersonSchema>;
export type HoldResponse = z.infer<typeof HoldResponseSchema>;
export type VerifyEmailResponse = z.infer<typeof VerifyEmailResponseSchema>;
export type ConfirmResponse = z.infer<typeof ConfirmResponseSchema>;
export type CancelResponse = z.infer<typeof CancelResponseSchema>;
export type RescheduleResponse = z.infer<typeof RescheduleResponseSchema>;
export type PublicApiErrorPayload = z.infer<typeof PublicApiErrorSchema>;
export type BookRouteInput = z.infer<typeof BookRouteInputSchema>;

export type PublicFlashTone = "success" | "error";

export type PublicFlashMessage = {
  tone: PublicFlashTone;
  text: string;
};

export type PublicErrorCode =
  | "invalid_input"
  | "invalid_token"
  | "expired"
  | "slot_unavailable"
  | "already_processed"
  | "config_error"
  | "request_failed"
  | "not_found"
  | "unknown";

export type PublicErrorContext =
  | "book"
  | "availability"
  | "confirm"
  | "cancel"
  | "reschedule";

export type PublicApiError = {
  code: PublicErrorCode;
  message: string;
};

export type PublicBookingEnhancerProps = {
  tenantSlug: string;
  initialDate: string;
  initialSlots: Slot[];
  initialAvailabilityError: string;
  bookingFormId: string;
};

export type BookRouteNormalizedFields = {
  date: string;
  name: string;
  email: string;
  public_notes: string;
  booking_mode: string;
};
