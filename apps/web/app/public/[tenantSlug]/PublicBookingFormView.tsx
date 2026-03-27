import PublicBookingEnhancer from "./PublicBookingEnhancer";
import { formatDateCaptionJst } from "./formatters";
import type { BookingMode, PublicFlashMessage, Slot } from "./types";

type PublicBookingFormViewProps = {
  tenantSlug: string;
  date: string;
  slots: Slot[];
  flashMessage: PublicFlashMessage | null;
  availabilityError: string;
  defaultName: string;
  defaultEmail: string;
  defaultPublicNotes: string;
  defaultBookingMode: BookingMode;
  debugInfo?: Record<string, unknown>;
};

export default function PublicBookingFormView({
  tenantSlug,
  date,
  slots,
  flashMessage,
  availabilityError,
  defaultName,
  defaultEmail,
  defaultPublicNotes,
  defaultBookingMode,
  debugInfo
}: PublicBookingFormViewProps) {
  const basePath = `/public/${encodeURIComponent(tenantSlug)}`;
  const bookPath = `${basePath}/book`;
  const bookingFormId = "public-booking-form";

  return (
    <main className="mx-auto max-w-5xl px-4 py-5 sm:px-6 sm:py-8">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr),minmax(0,1.3fr)]">
        <aside className="space-y-4 rounded-2xl border border-slate-200 bg-white p-5">
          <div className="space-y-1">
            <p className="text-xs font-semibold tracking-wide text-slate-500">PUBLIC BOOKING</p>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900">オンライン相談予約</h1>
            <p className="text-sm text-slate-600">日付、時間枠、連絡先を入力して確認メールを送信します。</p>
          </div>

          <div className="space-y-3 rounded-xl bg-slate-50 p-4">
            <div>
              <p className="text-xs text-slate-500">所要時間</p>
              <p className="text-sm font-semibold text-slate-900">60分</p>
            </div>
            <div>
              <p className="text-xs text-slate-500">開催形式</p>
              <p className="text-sm font-semibold text-slate-900">オンライン / オフライン</p>
            </div>
            <div>
              <p className="text-xs text-slate-500">ポリシー</p>
              <p className="text-sm text-slate-700">確認メール内リンクを開くと予約が確定します。直前変更やキャンセルには制限があります。</p>
            </div>
          </div>
        </aside>

        <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6">
          <div className="mb-4">
            <p className="text-sm text-slate-600">導線: 日付 → 時間枠 → 入力 → 送信</p>
          </div>

          {flashMessage ? (
            <p
              className={`mb-4 rounded-xl border px-4 py-3 text-sm ${
                flashMessage.tone === "success"
                  ? "border-emerald-300 bg-emerald-50 text-emerald-800"
                  : "border-rose-300 bg-rose-50 text-rose-800"
              }`}
            >
              {flashMessage.text}
            </p>
          ) : null}

          <div className="space-y-6">
            <section className="space-y-3">
              <div>
                <p className="text-sm font-semibold text-slate-900">1. 日付を選択</p>
                <p className="text-sm text-slate-600">非JS環境では日付更新ボタンで再表示します。</p>
              </div>

              <form method="get" action={basePath} className="flex flex-col gap-2 sm:flex-row sm:items-end">
                <label className="flex-1 space-y-1">
                  <span className="text-xs font-medium text-slate-700">日付</span>
                  <input
                    className="h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-base"
                    type="date"
                    name="date"
                    defaultValue={date}
                  />
                </label>
                <button
                  className="h-11 rounded-xl border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-800"
                  type="submit"
                >
                  日付を更新
                </button>
              </form>
              <p className="text-xs text-slate-500">表示中: {formatDateCaptionJst(date)}</p>
            </section>

            <form id={bookingFormId} method="post" action={bookPath} className="space-y-6">
              <section className="space-y-3">
                <div>
                  <p className="text-sm font-semibold text-slate-900">2. 時間枠を選択</p>
                  <p className="text-sm text-slate-600">JS有効時は高速更新UI、無効時は通常のラジオ選択で送信できます。</p>
                </div>

                <PublicBookingEnhancer
                  tenantSlug={tenantSlug}
                  initialDate={date}
                  initialSlots={slots}
                  initialAvailabilityError={availabilityError}
                  bookingFormId={bookingFormId}
                />
              </section>

              <section className="space-y-3">
                <div>
                  <p className="text-sm font-semibold text-slate-900">3. 連絡先を入力</p>
                  <p className="text-sm text-slate-600">確認メール送信先を入力してください。</p>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <label className="space-y-1">
                    <span className="text-xs font-medium text-slate-700">お名前</span>
                    <input
                      className="h-11 w-full rounded-xl border border-slate-300 px-3 text-base"
                      type="text"
                      name="customer_name"
                      defaultValue={defaultName}
                      required
                      maxLength={120}
                    />
                  </label>

                  <label className="space-y-1">
                    <span className="text-xs font-medium text-slate-700">メールアドレス</span>
                    <input
                      className="h-11 w-full rounded-xl border border-slate-300 px-3 text-base"
                      type="email"
                      name="customer_email"
                      defaultValue={defaultEmail}
                      required
                      maxLength={320}
                    />
                  </label>
                </div>

                <label className="space-y-1">
                  <span className="text-xs font-medium text-slate-700">相談内容（任意）</span>
                  <textarea
                    className="min-h-[88px] w-full rounded-xl border border-slate-300 px-3 py-2 text-base"
                    name="public_notes"
                    defaultValue={defaultPublicNotes}
                    maxLength={500}
                  />
                </label>

                <fieldset className="space-y-2">
                  <legend className="text-xs font-medium text-slate-700">開催形式</legend>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="flex h-11 items-center gap-2 rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-800">
                      <input
                        type="radio"
                        name="booking_mode"
                        value="online"
                        defaultChecked={defaultBookingMode === "online"}
                      />
                      オンライン
                    </label>
                    <label className="flex h-11 items-center gap-2 rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-800">
                      <input
                        type="radio"
                        name="booking_mode"
                        value="offline"
                        defaultChecked={defaultBookingMode === "offline"}
                      />
                      オフライン
                    </label>
                  </div>
                </fieldset>
              </section>

              <div className="sticky bottom-0 -mx-5 border-t border-slate-200 bg-white/95 px-5 pb-2 pt-3 backdrop-blur sm:-mx-6 sm:px-6">
                <p className="mb-2 text-xs text-slate-500">4. 送信すると確認メールを送信します。</p>
                <button
                  type="submit"
                  className="h-12 w-full rounded-xl bg-slate-900 px-4 text-base font-semibold text-white"
                >
                  確認メールを送信
                </button>
              </div>
            </form>
          </div>
        </section>
      </div>

      {debugInfo ? (
        <details className="mt-5 rounded-xl border border-slate-300 bg-slate-50 p-3 text-xs text-slate-700">
          <summary className="cursor-pointer font-semibold">Debug (通常は非表示)</summary>
          <pre className="mt-2 overflow-auto whitespace-pre-wrap">{JSON.stringify(debugInfo, null, 2)}</pre>
        </details>
      ) : null}
    </main>
  );
}
