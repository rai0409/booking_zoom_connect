import { classifyPublicApiError, messageFromErrorCode } from "../errors";
import { createIdempotencyKey, readSearchParam } from "../helpers";
import { confirmBookingServer, parseConfirm } from "../publicBookingApi";
import type { ConfirmResponse } from "../types";

export const dynamic = "force-dynamic";

type ConfirmPageProps = {
  params: { tenantSlug: string };
  searchParams?: Record<string, string | string[] | undefined>;
};

export default async function ConfirmPage({ params, searchParams }: ConfirmPageProps) {
  const token = readSearchParam(searchParams?.token).trim();
  const backPath = `/public/${encodeURIComponent(params.tenantSlug)}`;

  if (!token) {
    return (
      <main className="mx-auto max-w-2xl px-4 py-10">
        <div className="rounded-2xl border border-rose-300 bg-white p-6 space-y-4">
          <h1 className="text-xl font-bold text-slate-900">確認リンクが無効です</h1>
          <p className="text-sm text-slate-700">メール内の最新リンクから再度お試しください。</p>
          <a className="inline-flex h-11 items-center rounded-xl bg-slate-900 px-4 text-sm font-semibold text-white" href={backPath}>
            予約ページへ戻る
          </a>
        </div>
      </main>
    );
  }

  let apiError = "";
  let confirmResult: ConfirmResponse | null = null;

  try {
    const { res, text } = await confirmBookingServer(
      params.tenantSlug,
      token,
      createIdempotencyKey("confirm")
    );

    if (!res.ok) {
      apiError = classifyPublicApiError(res.status, text, "confirm").message;
    } else {
      confirmResult = parseConfirm(text);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    apiError = message.includes("APP_URL")
      ? messageFromErrorCode("config_error", "confirm")
      : messageFromErrorCode("request_failed", "confirm");
  }

  if (apiError) {
    return (
      <main className="mx-auto max-w-2xl px-4 py-10">
        <div className="rounded-2xl border border-rose-300 bg-white p-6 space-y-4">
          <h1 className="text-xl font-bold text-slate-900">予約確定に失敗しました</h1>
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
        <h1 className="text-xl font-bold text-slate-900">予約を確定しました</h1>
        <p className="text-sm text-slate-700">確認処理が完了しました。次の変更は確認メール内リンクをご利用ください。</p>
        <a className="inline-flex h-11 items-center rounded-xl bg-slate-900 px-4 text-sm font-semibold text-white" href={backPath}>
          予約ページへ戻る
        </a>

        {confirmResult ? (
          <details className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
            <summary className="cursor-pointer font-semibold">Debug (通常は非表示)</summary>
            <pre className="mt-2 overflow-auto whitespace-pre-wrap">{JSON.stringify(confirmResult, null, 2)}</pre>
          </details>
        ) : null}
      </div>
    </main>
  );
}
