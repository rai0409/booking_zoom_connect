"use client";

import { useEffect, useRef, useState } from "react";
import { classifyPublicApiError } from "./errors";
import { formatDateCaptionJst, formatSlotDateTimeJst, formatSlotTimeRangeJst } from "./formatters";
import { fetchAvailabilityClient, parseSlots } from "./publicBookingApi";
import type { PublicBookingEnhancerProps, Slot } from "./types";

export default function PublicBookingEnhancer({
  tenantSlug,
  initialDate,
  initialSlots,
  initialAvailabilityError,
  bookingFormId
}: PublicBookingEnhancerProps) {
  const [enhanced, setEnhanced] = useState(false);
  const [date, setDate] = useState(initialDate);
  const [slots, setSlots] = useState<Slot[]>(initialSlots);
  const [selected, setSelected] = useState<Slot | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState(initialAvailabilityError);

  const firstLoadKeyRef = useRef(`${tenantSlug}:${initialDate}`);
  const requestSeqRef = useRef(0);

  useEffect(() => {
    setEnhanced(true);
  }, []);

  useEffect(() => {
    if (!enhanced) return;

    const key = `${tenantSlug}:${date}`;
    if (firstLoadKeyRef.current === key) {
      firstLoadKeyRef.current = "";
      return;
    }

    const requestId = requestSeqRef.current + 1;
    requestSeqRef.current = requestId;

    const controller = new AbortController();

    setLoading(true);
    setErrorMessage("");
    setSelected(null);

    (async () => {
      const { res, text } = await fetchAvailabilityClient(tenantSlug, date, undefined, controller.signal);
      if (controller.signal.aborted || requestId !== requestSeqRef.current) return;

      if (!res.ok) {
        const classified = classifyPublicApiError(res.status, text, "availability");
        setErrorMessage(classified.message);
        setSlots([]);
        setLoading(false);
        return;
      }

      try {
        const parsedSlots = parseSlots(text);
        if (controller.signal.aborted || requestId !== requestSeqRef.current) return;
        setSlots(parsedSlots);
      } catch {
        if (controller.signal.aborted || requestId !== requestSeqRef.current) return;
        setErrorMessage("空き枠の解析に失敗しました。時間をおいて再度お試しください。");
        setSlots([]);
      } finally {
        if (controller.signal.aborted || requestId !== requestSeqRef.current) return;
        setLoading(false);
      }
    })().catch(() => {
      if (controller.signal.aborted || requestId !== requestSeqRef.current) return;
      setErrorMessage("空き枠の取得に失敗しました。時間をおいて再度お試しください。");
      setSlots([]);
      setLoading(false);
    });

    return () => {
      controller.abort();
    };
  }, [enhanced, tenantSlug, date]);

  return (
    <section className="space-y-3 rounded-2xl border border-slate-200 bg-slate-50 p-4">
      <input form={bookingFormId} name="date" type="hidden" value={date} readOnly />
      <input
        form={bookingFormId}
        name="start_at_utc"
        type="hidden"
        value={enhanced ? selected?.start_at_utc ?? "" : ""}
        readOnly
      />
      <input
        form={bookingFormId}
        name="end_at_utc"
        type="hidden"
        value={enhanced ? selected?.end_at_utc ?? "" : ""}
        readOnly
      />

      {!enhanced ? (
        <>
          {initialAvailabilityError ? (
            <p className="rounded-xl border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-700">
              {initialAvailabilityError}
            </p>
          ) : null}

          <div className="grid grid-cols-1 gap-2">
            {initialSlots.map((slot) => (
              <label
                key={`${slot.start_at_utc}-${slot.end_at_utc}`}
                className="flex min-h-[64px] cursor-pointer items-center rounded-xl border border-slate-300 bg-white px-4 py-3 transition hover:border-slate-500"
              >
                <input
                  type="radio"
                  name="slot_choice"
                  value={`${slot.start_at_utc}|${slot.end_at_utc}`}
                  required={initialSlots.length > 0}
                  className="h-4 w-4"
                />
                <span className="ml-3 flex-1">
                  <span className="block text-sm font-semibold text-slate-900">
                    {formatSlotTimeRangeJst(slot.start_at_utc, slot.end_at_utc)}
                  </span>
                  <span className="block text-xs text-slate-500">{formatSlotDateTimeJst(slot.start_at_utc)}</span>
                </span>
              </label>
            ))}
          </div>

          {initialSlots.length === 0 ? (
            <p className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              この日に予約可能な時間枠はありません。別の日付を選択してください。
            </p>
          ) : null}
        </>
      ) : (
        <>
          <label className="block space-y-1">
            <span className="text-xs font-medium text-slate-700">日付（JS高速更新）</span>
            <input
              className="h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-base"
              type="date"
              value={date}
              onChange={(event) => setDate(event.target.value)}
            />
          </label>

          <div className="text-xs text-slate-600">{formatDateCaptionJst(date)}</div>

          {loading ? <p className="text-sm text-slate-700">空き枠を更新中です...</p> : null}

          {errorMessage ? (
            <p className="rounded-xl border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-700">
              {errorMessage}
            </p>
          ) : null}

          {!loading && !errorMessage ? (
            <div className="grid grid-cols-1 gap-2">
              {slots.map((slot) => {
                const active =
                  selected?.start_at_utc === slot.start_at_utc &&
                  selected?.end_at_utc === slot.end_at_utc;

                return (
                  <button
                    key={`${slot.start_at_utc}-${slot.end_at_utc}`}
                    type="button"
                    className={`min-h-[64px] rounded-xl border px-4 py-3 text-left transition ${
                      active
                        ? "border-slate-900 bg-slate-900 text-white"
                        : "border-slate-300 bg-white text-slate-900 hover:border-slate-500"
                    }`}
                    onClick={() => setSelected(slot)}
                  >
                    <div className="text-sm font-semibold">
                      {formatSlotTimeRangeJst(slot.start_at_utc, slot.end_at_utc)}
                    </div>
                    <div className={`text-xs ${active ? "text-slate-200" : "text-slate-500"}`}>
                      {formatSlotDateTimeJst(slot.start_at_utc)}
                    </div>
                  </button>
                );
              })}
            </div>
          ) : null}

          {!loading && slots.length === 0 ? (
            <p className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              この日に予約可能な時間枠はありません。別の日付を選択してください。
            </p>
          ) : null}

          {selected ? (
            <p className="rounded-xl border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
              選択中: {formatSlotDateTimeJst(selected.start_at_utc)} ({formatSlotTimeRangeJst(selected.start_at_utc, selected.end_at_utc)})
            </p>
          ) : (
            <p className="text-sm text-slate-600">時間枠を1つ選択してください。</p>
          )}
        </>
      )}
    </section>
  );
}
