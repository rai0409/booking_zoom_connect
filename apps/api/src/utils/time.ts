import { DateTime } from "luxon";

export function parseIsoToUtc(isoWithTz: string): Date {
  const dt = DateTime.fromISO(isoWithTz, { setZone: true });
  if (!dt.isValid) {
    throw new Error("Invalid datetime");
  }
  return dt.toUTC().toJSDate();
}

export function utcNow(): Date {
  return DateTime.utc().toJSDate();
}

export function toIsoUtc(date: Date): string {
  return DateTime.fromJSDate(date, { zone: "utc" }).toISO({ suppressMilliseconds: true }) || "";
}

export function dateFromYmdLocal(ymd: string, timezone: string): DateTime {
  const dt = DateTime.fromISO(ymd, { zone: timezone });
  if (!dt.isValid) {
    throw new Error("Invalid date");
  }
  return dt.startOf("day");
}
