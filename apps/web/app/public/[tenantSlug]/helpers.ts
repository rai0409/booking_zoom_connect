import { createHash } from "crypto";
import { DateTime } from "luxon";
import type { BookRouteInput, BookRouteNormalizedFields, Slot } from "./types";
import { BookRouteInputSchema } from "./types";

const JST_ZONE = "Asia/Tokyo";

export function readSearchParam(value: string | string[] | undefined): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.length > 0) return value[0] ?? "";
  return "";
}

export function isValidYmd(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isExistingYmd(value: string): boolean {
  const dt = DateTime.fromFormat(value, "yyyy-LL-dd", { zone: JST_ZONE });
  return dt.isValid && dt.toFormat("yyyy-LL-dd") === value;
}

export function normalizeYmd(value: string, fallback: string): string {
  const trimmed = value.trim();
  if (!isValidYmd(trimmed)) return fallback;
  if (!isExistingYmd(trimmed)) return fallback;
  return trimmed;
}

function clampText(value: string, maxLen: number): string {
  return value.slice(0, maxLen);
}

export function normalizeText(value: FormDataEntryValue | null, maxLen: number): string {
  const raw = typeof value === "string" ? value : "";
  return clampText(raw.trim(), maxLen);
}

export function normalizeOptionalLine(value: FormDataEntryValue | null, maxLen: number): string {
  const raw = typeof value === "string" ? value : "";
  return clampText(raw.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim(), maxLen);
}

export function normalizeEmail(value: FormDataEntryValue | null): string {
  return normalizeText(value, 320).toLowerCase();
}

export function normalizeBookingMode(value: FormDataEntryValue | null): string {
  return normalizeText(value, 24).toLowerCase();
}

export function parseSlotChoice(value: FormDataEntryValue | null): Slot | null {
  if (typeof value !== "string") return null;
  const [start, end] = value.split("|");
  if (!start || !end) return null;

  const normalizedStart = start.trim();
  const normalizedEnd = end.trim();
  if (!normalizedStart || !normalizedEnd) return null;

  return { start_at_utc: normalizedStart, end_at_utc: normalizedEnd };
}

export function parseSlotFromFormData(formData: FormData): Slot | null {
  const start = normalizeText(formData.get("start_at_utc"), 64);
  const end = normalizeText(formData.get("end_at_utc"), 64);

  if (start && end) {
    return { start_at_utc: start, end_at_utc: end };
  }

  return parseSlotChoice(formData.get("slot_choice"));
}

export function buildPathWithQuery(
  pathname: string,
  query: Record<string, string | null | undefined>
): string {
  const params = new URLSearchParams();

  Object.entries(query).forEach(([key, value]) => {
    if (typeof value !== "string") return;
    if (!value) return;
    params.set(key, value);
  });

  const qs = params.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}

export function createIdempotencyKey(prefix: string): string {
  if (typeof globalThis.crypto === "undefined" || typeof globalThis.crypto.randomUUID !== "function") {
    throw new Error("crypto.randomUUID is required to create idempotency keys.");
  }

  return `${prefix}:${globalThis.crypto.randomUUID()}`;
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function getTimeBucket(bucketSeconds: number, nowMs = Date.now()): number {
  return Math.floor(nowMs / 1000 / bucketSeconds);
}

export function createHoldIdempotencyKey(args: {
  tenantSlug: string;
  customerEmail: string;
  startAtUtc: string;
  endAtUtc: string;
  bookingMode: string;
  bucketSeconds?: number;
  nowMs?: number;
}): string {
  const bucketSeconds = args.bucketSeconds ?? 60;
  const bucket = getTimeBucket(bucketSeconds, args.nowMs);
  const base = [
    "hold",
    args.tenantSlug.trim().toLowerCase(),
    args.customerEmail.trim().toLowerCase(),
    args.startAtUtc,
    args.endAtUtc,
    args.bookingMode,
    String(bucket)
  ].join("|");

  return `hold:${sha256Hex(base).slice(0, 40)}`;
}

export function createVerifyIdempotencyKey(args: {
  bookingId: string;
  customerEmail: string;
  bucketSeconds?: number;
  nowMs?: number;
}): string {
  const bucketSeconds = args.bucketSeconds ?? 60;
  const bucket = getTimeBucket(bucketSeconds, args.nowMs);
  const base = [
    "verify-email",
    args.bookingId.trim(),
    args.customerEmail.trim().toLowerCase(),
    String(bucket)
  ].join("|");

  return `verify:${sha256Hex(base).slice(0, 40)}`;
}

export type BookRouteParseResult =
  | {
      ok: true;
      input: BookRouteInput;
      normalized: BookRouteNormalizedFields;
    }
  | {
      ok: false;
      normalized: BookRouteNormalizedFields;
    };

export function parseBookRouteInput(args: {
  tenantSlug: string;
  fallbackDate: string;
  formData: FormData;
}): BookRouteParseResult {
  const date = normalizeYmd(normalizeText(args.formData.get("date"), 10), args.fallbackDate);
  const name = normalizeText(args.formData.get("customer_name"), 120);
  const email = normalizeEmail(args.formData.get("customer_email"));
  const publicNotes = normalizeOptionalLine(args.formData.get("public_notes"), 500);
  const bookingMode = normalizeBookingMode(args.formData.get("booking_mode"));
  const slot = parseSlotFromFormData(args.formData);

  const normalized: BookRouteNormalizedFields = {
    date,
    name,
    email,
    public_notes: publicNotes,
    booking_mode: bookingMode
  };

  if (!slot) {
    return { ok: false, normalized };
  }

  const parsed = BookRouteInputSchema.safeParse({
    tenantSlug: args.tenantSlug,
    date,
    customerName: name,
    customerEmail: email,
    bookingMode,
    publicNotes,
    start_at_utc: slot.start_at_utc,
    end_at_utc: slot.end_at_utc
  });

  if (!parsed.success) {
    return { ok: false, normalized };
  }

  return {
    ok: true,
    input: parsed.data,
    normalized
  };
}
