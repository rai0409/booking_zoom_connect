import { NextResponse } from "next/server";

type RouteContext = { params: Promise<{ tenantSlug: string }> };

export async function GET(req: Request, context: RouteContext) {
  const params = await context.params;
  const base = process.env.NEXT_PUBLIC_API_BASE ?? process.env.API_BASE_URL ?? "http://localhost:4000";
  const { searchParams } = new URL(req.url);
  const date = searchParams.get("date");
  const salesperson = searchParams.get("salesperson");

  const url = new URL(`${base}/v1/public/${params.tenantSlug}/availability`);
  if (date) url.searchParams.set("date", date);
  // Backward compatible: salesperson can still be forwarded when explicitly specified.
  if (salesperson) url.searchParams.set("salesperson", salesperson);

  const r = await fetch(url.toString(), { cache: "no-store" });
  const body = await r.text();
  return new NextResponse(body, {
    status: r.status,
    headers: { "Content-Type": r.headers.get("content-type") ?? "application/json" },
  });
}
