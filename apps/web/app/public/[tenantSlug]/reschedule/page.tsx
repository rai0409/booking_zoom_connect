import { redirect } from "next/navigation";
import { classifyPublicApiError, messageFromErrorCode } from "../errors";
import { formatDateCaptionJst, formatSlotDateTimeJst, formatSlotTimeRangeJst, todayJstYmd } from "../formatters";
import {
  buildPathWithQuery,
  createIdempotencyKey,
  normalizeText,
  normalizeYmd,
  parseSlotFromFormData,
  readSearchParam
} from "../helpers";
import {
  fetchAvailabilityServer,
  parseReschedule,
  parseSlots,
  rescheduleBookingServer
} from "../publicBookingApi";
import type { Slot } from "../types";

export const dynamic = "force-dynamic";

type ReschedulePageProps = {
  params: { tenantSlug: string };
  searchParams?: Record<string, string | string[] | undefined>;
};

async function submitRescheduleAction(tenantSlug: string, formData: FormData) {
  "use server";

  const basePath = `/public/${encodeURIComponent(tenantSlug)}/reschedule`;

  const token = normalizeText(formData.get("token"), 2048);
  const bookingId = normalizeText(formData.get("booking_id"), 128);
  const date = normalizeYmd(normalizeText(formData.get("date"), 10), todayJstYmd());
  const selectedSlot = parseSlotFromFormData(formData);

  if (!token || !bookingId) {
    redirect(
      buildPathWithQuery(basePath, {
        status: "reschedule_error",
        error: "invalid_link"
      })
    );
  }

  if (!selectedSlot) {
    redirect(
      buildPathWithQuery(basePath, {
        token,
        booking_id: bookingId,
        date,
        status: "reschedule_error",
        error: "invalid_input"
      })
    );
  }

  try {
    const { res, text } = await rescheduleBookingServer(
      tenantSlug,
      bookingId,
      token,
      selectedSlot as Slot,
      createIdempotencyKey("reschedule")
    );

    if (!res.ok) {
      const classified = classifyPublicApiError(res.status, text, "reschedule");
      redirect(
        buildPathWithQuery(basePath, {
          token,
          booking_id: bookingId,
          date,
          status: "reschedule_error",
          error: classified.code
        })
      );
    }

    parseReschedule(text);

    redirect(buildPathWithQuery(basePath, { status: "reschedule_success" }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    redirect(
      buildPathWithQuery(basePath, {
        token,
        booking_id: bookingId,
        date,
        status: "reschedule_error",
        error: message.includes("APP_URL") ? "config_error" : "request_failed"
      })
    );
  }
}

export default async function ReschedulePage({ params, searchParams }: ReschedulePageProps) {
  const token = readSearchParam(searchParams?.token).trim();
  const bookingId = readSearchParam(searchParams?.booking_id).trim();
  const date = normalizeYmd(readSearchParam(searchParams?.date), todayJstYmd());

  const status = readSearchParam(searchParams?.status);
  const errorCode = readSearchParam(searchParams?.error);

  const backPath = `/public/${encodeURIComponent(params.tenantSlug)}`;
  const basePath = `/public/${encodeURIComponent(params.tenantSlug)}/reschedule`;

  if (status === "reschedule_success") {
    return (
      <main className="mx-auto max-w-2xl px-4 py-10">
        <div className="rounded-2xl border border-emerald-300 bg-white p-6 space-y-4">
          <h1 className="text-xl font-bold text-slate-900">日程変更が完了しました</h1>
          <p className="text-sm text-slate-700">新しい時間枠への変更処理が完了しました。</p>
          <a className="inline-flex h-11 items-center rounded-xl bg-slate-900 px-4 text-sm font-semibold text-white" href={backPath}>
            予約ページへ戻る
          </a>
        </div>
      </main>
    );
  }

  if (!token || !bookingId) {
    return (
      <main className="mx-auto max-w-2xl px-4 py-10">
        <div className="rounded-2xl border border-rose-300 bg-white p-6 space-y-4">
          <h1 className="text-xl font-bold text-slate-900">変更リンクが無効です</h1>
          <p className="text-sm text-slate-700">メール内の最新リンクから再度お試しください。</p>
          <a className="inline-flex h-11 items-center rounded-xl bg-slate-900 px-4 text-sm font-semibold text-white" href={backPath}>
            予約ページへ戻る
          </a>
        </div>
      </main>
    );
  }

  let slots: Slot[] = [];
  let availabilityError = "";

  try {
    const { res, text } = await fetchAvailabilityServer(params.tenantSlug, date);

    if (!res.ok) {
      availabilityError = classifyPublicApiError(res.status, text, "availability").message;
    } else {
      slots = parseSlots(text);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    availabilityError = message.includes("APP_URL")
      ? messageFromErrorCode("config_error", "reschedule")
      : messageFromErrorCode("request_failed", "reschedule");
  }

  const action = submitRescheduleAction.bind(null, params.tenantSlug);

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6 space-y-5">
        <header className="space-y-1">
          <h1 className="text-xl font-bold text-slate-900">日程変更</h1>
          <p className="text-sm text-slate-600">日付と時間枠を選択して、変更を実行してください。</p>
        </header>

        {status === "reschedule_error" ? (
          <p className="rounded-xl border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            {messageFromErrorCode(errorCode || "unknown", "reschedule")}
          </p>
        ) : null}

        {availabilityError ? (
          <p className="rounded-xl border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-700">{availabilityError}</p>
        ) : null}

        <form method="get" action={basePath} className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <input type="hidden" name="token" value={token} readOnly />
          <input type="hidden" name="booking_id" value={bookingId} readOnly />

          <label className="flex-1 space-y-1">
            <span className="text-xs font-medium text-slate-700">日付</span>
            <input
              className="h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-base"
              type="date"
              name="date"
              defaultValue={date}
            />
          </label>

          <button className="h-11 rounded-xl border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-800" type="submit">
            日付を更新
          </button>
        </form>

        <p className="text-xs text-slate-500">表示中: {formatDateCaptionJst(date)}</p>

        <form action={action} className="space-y-4">
          <input type="hidden" name="token" value={token} readOnly />
          <input type="hidden" name="booking_id" value={bookingId} readOnly />
          <input type="hidden" name="date" value={date} readOnly />

          <div className="grid grid-cols-1 gap-2">
            {slots.map((slot) => (
              <label
                key={`${slot.start_at_utc}-${slot.end_at_utc}`}
                className="flex min-h-[64px] cursor-pointer items-center rounded-xl border border-slate-300 bg-white px-4 py-3 transition hover:border-slate-500"
              >
                <input
                  type="radio"
                  name="slot_choice"
                  value={`${slot.start_at_utc}|${slot.end_at_utc}`}
                  required={slots.length > 0}
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

          {slots.length === 0 ? (
            <p className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              この日に変更可能な時間枠はありません。別の日付を選択してください。
            </p>
          ) : null}

          <div className="sticky bottom-0 rounded-xl border border-slate-200 bg-white/95 p-3 backdrop-blur">
            <button
              type="submit"
              className="h-12 w-full rounded-xl bg-slate-900 px-4 text-base font-semibold text-white"
              disabled={slots.length === 0}
            >
              この枠へ変更する
            </button>
          </div>
        </form>
      </section>
    </main>
  );
}
