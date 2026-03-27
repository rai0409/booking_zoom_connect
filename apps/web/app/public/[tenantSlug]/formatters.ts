import { DateTime } from "luxon";

const JST_ZONE = "Asia/Tokyo";

export function todayJstYmd(): string {
  return DateTime.now().setZone(JST_ZONE).toFormat("yyyy-LL-dd");
}

export function formatDateCaptionJst(ymd: string): string {
  const dt = DateTime.fromFormat(ymd, "yyyy-LL-dd", { zone: JST_ZONE });
  if (!dt.isValid) return ymd;
  return dt.toFormat("yyyy/LL/dd (ccc)");
}

export function formatSlotTimeRangeJst(startAtUtc: string, endAtUtc: string): string {
  const start = DateTime.fromISO(startAtUtc, { zone: "utc" }).setZone(JST_ZONE);
  const end = DateTime.fromISO(endAtUtc, { zone: "utc" }).setZone(JST_ZONE);
  if (!start.isValid || !end.isValid) return "時刻不明";
  return `${start.toFormat("HH:mm")} - ${end.toFormat("HH:mm")}`;
}

export function formatSlotDateTimeJst(startAtUtc: string): string {
  const start = DateTime.fromISO(startAtUtc, { zone: "utc" }).setZone(JST_ZONE);
  if (!start.isValid) return "";
  return start.toFormat("yyyy/LL/dd HH:mm");
}
