import { NextResponse } from "next/server";

export async function GET(_: Request, { params }: { params: { tenantSlug: string } }) {
  const base = process.env.NEXT_PUBLIC_API_BASE!;
  const r = await fetch(`${base}/v1/public/${params.tenantSlug}/salespersons`, { cache: "no-store" });
  const body = await r.text();
  return new NextResponse(body, {
    status: r.status,
    headers: { "Content-Type": r.headers.get("content-type") ?? "application/json" },
  });
}
