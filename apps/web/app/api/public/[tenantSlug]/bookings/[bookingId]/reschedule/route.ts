import { NextResponse } from "next/server";

type RouteContext = { params: Promise<{ tenantSlug: string; bookingId: string }> };

export async function POST(req: Request, context: RouteContext) {
  const params = await context.params;
  const base = process.env.API_BASE_URL ?? "http://127.0.0.1:4000";
  const idem = req.headers.get("idempotency-key") ?? req.headers.get("Idempotency-Key");
  const payload = await req.json();

  const r = await fetch(`${base}/v1/public/${params.tenantSlug}/bookings/${params.bookingId}/reschedule`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(idem ? { "Idempotency-Key": idem } : {})
    },
    body: JSON.stringify({
      token: payload?.token,
      new_start_at: payload?.new_start_at,
      new_end_at: payload?.new_end_at
    })
  });

  const body = await r.text();
  return new NextResponse(body, {
    status: r.status,
    headers: { "Content-Type": r.headers.get("content-type") ?? "application/json" }
  });
}
