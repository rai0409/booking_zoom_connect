import { NextResponse } from "next/server";

export async function POST(req: Request, { params }: { params: { tenantSlug: string } }) {
  const base = process.env.NEXT_PUBLIC_API_BASE!;
  const idem = req.headers.get("idempotency-key") ?? req.headers.get("Idempotency-Key");
  const payload = await req.json();

  const r = await fetch(`${base}/v1/public/${params.tenantSlug}/holds`, {
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
