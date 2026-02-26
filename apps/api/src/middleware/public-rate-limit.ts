import type { Request, Response, NextFunction } from "express";

type Bucket = { count: number; resetAtMs: number };

export function createPublicRateLimiter(opts?: {
  windowMs?: number;
  holdsMax?: number;
  confirmMax?: number;
  verifyMax?: number;
}) {
  const enabled = (process.env.RATE_LIMIT_ENABLED ?? "1") !== "0";
  const windowMs = opts?.windowMs ?? Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000);
  const holdsMax = opts?.holdsMax ?? Number(process.env.RATE_LIMIT_HOLDS_MAX ?? 30);
  const confirmMax = opts?.confirmMax ?? Number(process.env.RATE_LIMIT_CONFIRM_MAX ?? 30);
  const verifyMax = opts?.verifyMax ?? Number(process.env.RATE_LIMIT_VERIFY_MAX ?? 20);

  const buckets = new Map<string, Bucket>();

  function keyFor(req: Request, tenantSlug: string, kind: string) {
    const xf = (req.headers["x-forwarded-for"] as string | undefined) || "";
    const ip = xf.split(",")[0]?.trim() || req.ip || "unknown";
    return `${tenantSlug}:${kind}:${ip}`;
  }

  function check(req: Request, tenantSlug: string, kind: string, limit: number): boolean {
    const now = Date.now();
    const k = keyFor(req, tenantSlug, kind);
    const b = buckets.get(k);
    if (!b || b.resetAtMs <= now) {
      buckets.set(k, { count: 1, resetAtMs: now + windowMs });
      return true;
    }
    b.count += 1;
    buckets.set(k, b);
    return b.count <= limit;
  }

  return (req: Request, res: Response, next: NextFunction) => {
    if (!enabled) return next();

    const url = req.originalUrl || req.url || "";
    if (!url.startsWith("/v1/public/")) return next();

    const parts = url.split("?")[0].split("/").filter(Boolean);
    // parts: ["v1","public",":tenantSlug", ...]
    const tenantSlug = parts[2];
    const tail = parts.slice(3).join("/");

    // Only throttle write endpoints
    if (req.method !== "POST") return next();

    if (tail === "holds") {
      if (!check(req, tenantSlug, "holds", holdsMax)) return tooMany(res);
    } else if (tail === "confirm") {
      if (!check(req, tenantSlug, "confirm", confirmMax)) return tooMany(res);
    } else if (tail === "auth/verify-email") {
      if (!check(req, tenantSlug, "verify", verifyMax)) return tooMany(res);
    }

    return next();
  };
}

function tooMany(res: Response) {
  res.status(429).json({ error: "rate limit" });
}
