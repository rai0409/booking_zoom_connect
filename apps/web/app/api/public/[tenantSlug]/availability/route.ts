import { NextResponse } from "next/server";

export async function GET(req: Request, { params }: { params: { tenantSlug: string } }) {
  const base = process.env.NEXT_PUBLIC_API_BASE!;
  const { searchParams } = new URL(req.url);
  const salesperson = searchParams.get("salesperson");
  const date = searchParams.get("date");

  const url = new URL(`${base}/v1/public/${params.tenantSlug}/availability`);
  if (salesperson) url.searchParams.set("salesperson", salesperson);
  if (date) url.searchParams.set("date", date);

  const r = await fetch(url.toString(), { cache: "no-store" });
  const body = await r.text();
  return new NextResponse(body, {
    status: r.status,
    headers: { "Content-Type": r.headers.get("content-type") ?? "application/json" },
  });
}
