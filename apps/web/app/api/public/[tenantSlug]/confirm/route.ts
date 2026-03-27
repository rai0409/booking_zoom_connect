import { NextResponse } from "next/server";
import { randomUUID } from "crypto";

type RouteContext = { params: Promise<{ tenantSlug: string }> };

export async function POST(req: Request, context: RouteContext) {
  const params = await context.params;
  const base = process.env.API_BASE_URL ?? "http://127.0.0.1:4000";
  const idem = req.headers.get("idempotency-key") ?? req.headers.get("Idempotency-Key") ?? randomUUID();
  const payload = await req.json().catch(() => ({}));
  const token = payload?.token;
  if (!token || typeof token !== "string") {
    return NextResponse.json({ message: "token required", code: "INVALID_TOKEN" }, { status: 400 });
  }

  const r = await fetch(`${base}/v1/public/${params.tenantSlug}/confirm`, {
    method: "POST",
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idem,
    },
    body: JSON.stringify({ token }),
  });

  const body = await r.text();
  return new NextResponse(body, {
    status: r.status,
    headers: { "Content-Type": r.headers.get("content-type") ?? "application/json" },
  });
}
