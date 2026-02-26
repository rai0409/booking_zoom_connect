import { NextResponse } from "next/server";

type RouteContext = { params: Promise<{ tenantSlug: string }> };

export async function POST(req: Request, context: RouteContext) {
  const params = await context.params;
  const base = process.env.NEXT_PUBLIC_API_BASE!;
  const idem = req.headers.get("idempotency-key") ?? req.headers.get("Idempotency-Key");
  const payload = await req.json();

  const r = await fetch(`${base}/v1/public/${params.tenantSlug}/auth/verify-email`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(idem ? { "Idempotency-Key": idem } : {}),
    },
    body: JSON.stringify(payload),
  });

  const body = await r.text();
  return new NextResponse(body, {
    status: r.status,
    headers: { "Content-Type": r.headers.get("content-type") ?? "application/json" },
  });
}
