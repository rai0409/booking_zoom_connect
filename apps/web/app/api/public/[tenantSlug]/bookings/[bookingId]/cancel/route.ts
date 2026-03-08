import { NextResponse } from "next/server";

type RouteContext = { params: Promise<{ tenantSlug: string; bookingId: string }> };

export async function POST(req: Request, context: RouteContext) {
  const params = await context.params;
  const base = process.env.NEXT_PUBLIC_API_BASE ?? process.env.API_BASE_URL ?? "http://localhost:4000";
  const idem = req.headers.get("idempotency-key") ?? req.headers.get("Idempotency-Key");
  const payload = await req.json();
  const token = payload?.token;

  const r = await fetch(`${base}/v1/public/${params.tenantSlug}/bookings/${params.bookingId}/cancel`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(idem ? { "Idempotency-Key": idem } : {})
    },
    body: JSON.stringify({ token })
  });

  const body = await r.text();
  return new NextResponse(body, {
    status: r.status,
    headers: { "Content-Type": r.headers.get("content-type") ?? "application/json" }
  });
}
