import { z } from "zod";
import {
  CancelResponseSchema,
  ConfirmResponseSchema,
  HoldResponseSchema,
  PublicApiErrorSchema,
  RescheduleResponseSchema,
  SalespersonSchema,
  SlotSchema,
  VerifyEmailResponseSchema
} from "./types";
import type {
  BookingMode,
  CancelResponse,
  ConfirmResponse,
  HoldResponse,
  PublicApiErrorPayload,
  RescheduleResponse,
  Salesperson,
  Slot,
  VerifyEmailResponse
} from "./types";

type HoldPayload = {
  salesperson_id?: string;
  start_at: string;
  end_at: string;
  booking_mode: BookingMode;
  public_notes?: string;
  customer: {
    email: string;
    name?: string;
    company?: string;
  };
};

type RequestResult = {
  res: Response;
  text: string;
};

export class PublicApiParseError extends Error {
  constructor(schemaName: string, detail: string) {
    super(`Failed to parse ${schemaName}: ${detail}`);
    this.name = "PublicApiParseError";
  }
}

function getAppUrlOrThrow(): string {
  const appUrl = process.env.APP_URL?.trim();
  if (!appUrl) {
    throw new Error("APP_URL is required for server-side public booking requests.");
  }

  return appUrl.endsWith("/") ? appUrl.slice(0, -1) : appUrl;
}

function readText(res: Response): Promise<string> {
  return res.text();
}

function buildQuery(params: Record<string, string | undefined>): string {
  const query = new URLSearchParams();

  Object.entries(params).forEach(([key, value]) => {
    if (!value) return;
    query.set(key, value);
  });

  const raw = query.toString();
  return raw ? `?${raw}` : "";
}

function parseWithSchema<T>(
  text: string,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  schemaName: string
): T {
  let parsedJson: unknown;

  try {
    parsedJson = JSON.parse(text);
  } catch {
    throw new PublicApiParseError(schemaName, "invalid JSON payload");
  }

  const parsed = schema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new PublicApiParseError(schemaName, parsed.error.message);
  }

  return parsed.data;
}

async function serverRequest(pathname: string, init?: RequestInit): Promise<RequestResult> {
  const url = `${getAppUrlOrThrow()}${pathname}`;
  const res = await fetch(url, {
    cache: "no-store",
    ...init
  });

  return { res, text: await readText(res) };
}

export async function fetchAvailabilityServer(
  tenantSlug: string,
  date: string,
  salespersonId?: string
): Promise<RequestResult> {
  return serverRequest(
    `/api/public/${tenantSlug}/availability${buildQuery({ date, salesperson: salespersonId })}`
  );
}

export async function fetchSalespersonsServer(tenantSlug: string): Promise<RequestResult> {
  return serverRequest(`/api/public/${tenantSlug}/salespersons`);
}

export async function createHoldServer(
  tenantSlug: string,
  payload: HoldPayload,
  idempotencyKey: string
): Promise<RequestResult> {
  return serverRequest(`/api/public/${tenantSlug}/holds`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey
    },
    body: JSON.stringify(payload)
  });
}

export async function sendVerifyEmailServer(
  tenantSlug: string,
  bookingId: string,
  idempotencyKey: string
): Promise<RequestResult> {
  return serverRequest(`/api/public/${tenantSlug}/verify-email`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey
    },
    body: JSON.stringify({ booking_id: bookingId })
  });
}

export async function confirmBookingServer(
  tenantSlug: string,
  token: string,
  idempotencyKey: string
): Promise<RequestResult> {
  return serverRequest(`/api/public/${tenantSlug}/confirm`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey
    },
    body: JSON.stringify({ token })
  });
}

export async function cancelBookingServer(
  tenantSlug: string,
  bookingId: string,
  token: string,
  idempotencyKey: string
): Promise<RequestResult> {
  return serverRequest(`/api/public/${tenantSlug}/bookings/${bookingId}/cancel`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey
    },
    body: JSON.stringify({ token })
  });
}

export async function rescheduleBookingServer(
  tenantSlug: string,
  bookingId: string,
  token: string,
  slot: Slot,
  idempotencyKey: string
): Promise<RequestResult> {
  return serverRequest(`/api/public/${tenantSlug}/bookings/${bookingId}/reschedule`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey
    },
    body: JSON.stringify({
      token,
      new_start_at: slot.start_at_utc,
      new_end_at: slot.end_at_utc
    })
  });
}

export async function fetchAvailabilityClient(
  tenantSlug: string,
  date: string,
  salespersonId?: string,
  signal?: AbortSignal
): Promise<RequestResult> {
  const res = await fetch(
    `/api/public/${tenantSlug}/availability${buildQuery({ date, salesperson: salespersonId })}`,
    {
      cache: "no-store",
      signal
    }
  );

  return { res, text: await readText(res) };
}

export function parsePublicApiErrorPayload(text: string): PublicApiErrorPayload {
  return parseWithSchema(text, PublicApiErrorSchema, "PublicApiErrorSchema");
}

export function parseSlots(text: string): Slot[] {
  return parseWithSchema(text, z.array(SlotSchema), "SlotSchema[]");
}

export function parseHold(text: string): HoldResponse {
  return parseWithSchema(text, HoldResponseSchema, "HoldResponseSchema");
}

export function parseVerifyEmail(text: string): VerifyEmailResponse {
  return parseWithSchema(text, VerifyEmailResponseSchema, "VerifyEmailResponseSchema");
}

export function parseConfirm(text: string): ConfirmResponse {
  return parseWithSchema(text, ConfirmResponseSchema, "ConfirmResponseSchema");
}

export function parseCancel(text: string): CancelResponse {
  return parseWithSchema(text, CancelResponseSchema, "CancelResponseSchema");
}

export function parseReschedule(text: string): RescheduleResponse {
  return parseWithSchema(text, RescheduleResponseSchema, "RescheduleResponseSchema");
}

export function parseSalespersons(text: string): Salesperson[] {
  return parseWithSchema(text, z.array(SalespersonSchema), "SalespersonSchema[]");
}
