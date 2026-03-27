import { classifyPublicApiError, messageFromErrorCode } from "../errors";
import { createIdempotencyKey, readSearchParam } from "../helpers";
import { cancelBookingServer, parseCancel } from "../publicBookingApi";

export const dynamic = "force-dynamic";

type CancelPageProps = {
  params: { tenantSlug: string };
  searchParams?: Record<string, string | string[] | undefined>;
};

export default async function CancelPage({ params, searchParams }: CancelPageProps) {
  const token = readSearchParam(searchParams?.token).trim();
  const bookingId = readSearchParam(searchParams?.booking_id).trim();
  const backPath = `/public/${encodeURIComponent(params.tenantSlug)}`;

  if (!token || !bookingId) {
    return (
      <main className="mx-auto max-w-2xl px-4 py-10">
        <div className="rounded-2xl border border-rose-300 bg-white p-6 space-y-4">
          <h1 className="text-xl font-bold text-slate-900">キャンセルリンクが無効です</h1>
          <p className="text-sm text-slate-700">メール内の最新リンクから再度お試しください。</p>
          <a className="inline-flex h-11 items-center rounded-xl bg-slate-900 px-4 text-sm font-semibold text-white" href={backPath}>
            予約ページへ戻る
          </a>
        </div>
      </main>
    );
  }

  let apiError = "";

  try {
    const { res, text } = await cancelBookingServer(
      params.tenantSlug,
      bookingId,
      token,
      createIdempotencyKey("cancel")
    );

    if (!res.ok) {
      apiError = classifyPublicApiError(res.status, text, "cancel").message;
    } else {
      parseCancel(text);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    apiError = message.includes("APP_URL")
      ? messageFromErrorCode("config_error", "cancel")
      : messageFromErrorCode("request_failed", "cancel");
  }

  if (apiError) {
    return (
      <main className="mx-auto max-w-2xl px-4 py-10">
        <div className="rounded-2xl border border-rose-300 bg-white p-6 space-y-4">
          <h1 className="text-xl font-bold text-slate-900">キャンセルに失敗しました</h1>
          <p className="text-sm text-rose-700">{apiError}</p>
          <a className="inline-flex h-11 items-center rounded-xl bg-slate-900 px-4 text-sm font-semibold text-white" href={backPath}>
            予約ページへ戻る
          </a>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <div className="rounded-2xl border border-emerald-300 bg-white p-6 space-y-4">
        <h1 className="text-xl font-bold text-slate-900">キャンセルが完了しました</h1>
        <p className="text-sm text-slate-700">予約のキャンセル処理が完了しました。</p>
        <a className="inline-flex h-11 items-center rounded-xl bg-slate-900 px-4 text-sm font-semibold text-white" href={backPath}>
          予約ページへ戻る
        </a>
      </div>
    </main>
  );
}
