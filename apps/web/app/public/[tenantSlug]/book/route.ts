import { NextResponse } from "next/server";
import { classifyPublicApiError } from "../errors";
import { todayJstYmd } from "../formatters";
import {
  buildPathWithQuery,
  createHoldIdempotencyKey,
  createVerifyIdempotencyKey,
  parseBookRouteInput
} from "../helpers";
import {
  createHoldServer,
  parseHold,
  parseVerifyEmail,
  sendVerifyEmailServer
} from "../publicBookingApi";

type RouteContext = { params: Promise<{ tenantSlug: string }> };

function toRedirect(req: Request, path: string) {
  return NextResponse.redirect(new URL(path, req.url), 303);
}

export async function POST(req: Request, context: RouteContext) {
  const params = await context.params;
  const basePath = `/public/${encodeURIComponent(params.tenantSlug)}`;

  const formData = await req.formData();
  const parsedInput = parseBookRouteInput({
    tenantSlug: params.tenantSlug,
    fallbackDate: todayJstYmd(),
    formData
  });

  const preserved = parsedInput.normalized;

  if (!parsedInput.ok) {
    return toRedirect(
      req,
      buildPathWithQuery(basePath, {
        ...preserved,
        status: "book_error",
        error: "invalid_input"
      })
    );
  }

  const input = parsedInput.input;

  try {
    const holdIdempotencyKey = createHoldIdempotencyKey({
      tenantSlug: input.tenantSlug,
      customerEmail: input.customerEmail,
      startAtUtc: input.start_at_utc,
      endAtUtc: input.end_at_utc,
      bookingMode: input.bookingMode,
      bucketSeconds: 60
    });

    const { res: holdRes, text: holdText } = await createHoldServer(
      params.tenantSlug,
      {
        start_at: input.start_at_utc,
        end_at: input.end_at_utc,
        booking_mode: input.bookingMode,
        public_notes: input.publicNotes,
        customer: {
          email: input.customerEmail,
          name: input.customerName
        }
      },
      holdIdempotencyKey
    );

    if (!holdRes.ok) {
      const classified = classifyPublicApiError(holdRes.status, holdText, "book");
      return toRedirect(
        req,
        buildPathWithQuery(basePath, {
          ...preserved,
          status: "book_error",
          error: classified.code
        })
      );
    }

    const hold = parseHold(holdText);
    if (!hold.id) {
      return toRedirect(
        req,
        buildPathWithQuery(basePath, {
          ...preserved,
          status: "book_error",
          error: "request_failed"
        })
      );
    }

    const verifyIdempotencyKey = createVerifyIdempotencyKey({
      bookingId: hold.id,
      customerEmail: input.customerEmail,
      bucketSeconds: 60
    });

    const { res: verifyRes, text: verifyText } = await sendVerifyEmailServer(
      params.tenantSlug,
      hold.id,
      verifyIdempotencyKey
    );

    if (!verifyRes.ok) {
      const classified = classifyPublicApiError(verifyRes.status, verifyText, "book");
      return toRedirect(
        req,
        buildPathWithQuery(basePath, {
          ...preserved,
          status: "book_error",
          error: classified.code
        })
      );
    }

    parseVerifyEmail(verifyText);

    return toRedirect(
      req,
      buildPathWithQuery(basePath, {
        date: input.date,
        status: "verification_sent"
      })
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return toRedirect(
      req,
      buildPathWithQuery(basePath, {
        ...preserved,
        status: "book_error",
        error: message.includes("APP_URL") ? "config_error" : "request_failed"
      })
    );
  }
}
