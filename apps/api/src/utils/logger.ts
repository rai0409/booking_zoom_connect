export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Minimal structured logger.
 * Keep signature stable for service code and tests.
 */
export function log(level: LogLevel, event: string, meta: Record<string, unknown> = {}): void {
  if (process.env.NODE_ENV === "test") {
    if (level !== "warn" && level !== "error") return;
  }
  const payload = { level, event, ...meta, ts: new Date().toISOString() };
  const line = JSON.stringify(payload);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
