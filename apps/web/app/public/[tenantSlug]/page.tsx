"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";

type Slot = { start_at_utc: string; end_at_utc: string };
type Salesperson = { id: string; display_name: string; timezone?: string };
type HoldResp = { id: string; status: string; start_at_utc: string; end_at_utc: string; hold: { expires_at_utc: string } };
type VerifyResp = { status: string; token?: string };
type ConfirmResp = { status: string; booking_id: string; cancel_url?: string; reschedule_url?: string };
type CancelResp = { status: string };
type RescheduleResp = {
  status: string;
  booking_id: string;
  old_start_at_utc: string;
  old_end_at_utc: string;
  new_start_at_utc: string;
  new_end_at_utc: string;
};
type TokenAction = "confirm" | "cancel" | "reschedule";
type ActionType = "form" | TokenAction;
type SuccessType = "confirm_success" | "cancel_success" | "reschedule_success" | "verification_sent";
type RecoverableErrorType = "token_expired_or_used" | "hold_expired" | "slot_unavailable" | "retry_required";
type FatalErrorType = "invalid_link" | "request_failed" | "unexpected_error";
type ErrorType = RecoverableErrorType | FatalErrorType;
type ResultType = null | "success" | "retryable_error" | "fatal_error";

function extractErrorText(raw: string) {
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw) as { message?: unknown; error?: unknown };
    if (Array.isArray(parsed.message)) return parsed.message.join(", ");
    if (typeof parsed.message === "string") return parsed.message;
    if (typeof parsed.error === "string") return parsed.error;
  } catch {
    // plain text error is also valid
  }
  return raw;
}

function classifyActionError(status: number, raw: string, action: TokenAction): {
  resultType: Exclude<ResultType, null>;
  errorType: ErrorType;
  message: string;
} {
  const message = extractErrorText(raw);
  const normalized = `${status} ${message}`.toLowerCase();

  if (
    (normalized.includes("token") && normalized.includes("expired")) ||
    normalized.includes("already used") ||
    normalized.includes("既に使用")
  ) {
    return {
      resultType: "retryable_error",
      errorType: "token_expired_or_used",
      message: "リンクの有効期限が切れているか、既に使用されています。"
    };
  }
  if (normalized.includes("hold") && normalized.includes("expired")) {
    return {
      resultType: "retryable_error",
      errorType: "hold_expired",
      message: "予約保持の有効期限が切れています。もう一度時間枠を選択してください。"
    };
  }
  if (
    (normalized.includes("slot") && normalized.includes("taken")) ||
    normalized.includes("slot unavailable") ||
    normalized.includes("already taken")
  ) {
    return {
      resultType: "retryable_error",
      errorType: "slot_unavailable",
      message: "選択した時間枠は利用できません。別の時間枠で再度お試しください。"
    };
  }
  if (status === 409) {
    return {
      resultType: "retryable_error",
      errorType: "retry_required",
      message:
        action === "reschedule"
          ? "このリンクでは日程変更を完了できませんでした。再度リンクを開いてお試しください。"
          : "このリンクでは処理を完了できませんでした。再度お試しください。"
    };
  }
  if (
    status === 400 ||
    status === 401 ||
    status === 403 ||
    status === 404 ||
    normalized.includes("invalid token") ||
    normalized.includes("token required") ||
    normalized.includes("token booking mismatch")
  ) {
    return {
      resultType: "fatal_error",
      errorType: "invalid_link",
      message: "リンクが無効です。メールの最新リンクをご利用ください。"
    };
  }
  if (status >= 500) {
    return {
      resultType: "fatal_error",
      errorType: "request_failed",
      message: "現在処理できません。時間をおいて再度お試しください。"
    };
  }
  return {
    resultType: "fatal_error",
    errorType: "request_failed",
    message: "リクエストに失敗しました。"
  };
}

function formatActionErrorLabel(errorType: ErrorType | null) {
  switch (errorType) {
    case "token_expired_or_used":
      return "token_expired_or_used";
    case "hold_expired":
      return "hold_expired";
    case "slot_unavailable":
      return "slot_unavailable";
    case "retry_required":
      return "retry_required";
    case "invalid_link":
      return "invalid_link";
    case "request_failed":
      return "request_failed";
    case "unexpected_error":
      return "unexpected_error";
    default:
      return "";
  }
}

export default function PublicBookingPage({ params }: { params: { tenantSlug: string } }) {
  const tenantSlug = params.tenantSlug;
  const searchParams = useSearchParams();
  const token = searchParams.get("token") || "";
  const actionParam = searchParams.get("action") || "";
  const queryBookingId = (searchParams.get("booking_id") || "").trim();
  const storageKey = useMemo(() => `public-booking:${tenantSlug}:booking_id`, [tenantSlug]);
  const tokenAction = useMemo<TokenAction | null>(() => {
    if (!token) return null;
    if (actionParam === "confirm" || actionParam === "cancel" || actionParam === "reschedule") {
      return actionParam;
    }
    // Legacy fallback: old links with token but without action are treated as confirm.
    return "confirm";
  }, [actionParam, token]);
  const actionType: ActionType = tokenAction ?? "form";

  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [slots, setSlots] = useState<Slot[]>([]);
  const [selected, setSelected] = useState<Slot | null>(null);

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [publicNotes, setPublicNotes] = useState("");
  const [bookingMode, setBookingMode] = useState<"online" | "offline">("online");

  const [loadingSlots, setLoadingSlots] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [resultType, setResultType] = useState<ResultType>(null);
  const [successType, setSuccessType] = useState<SuccessType | null>(null);
  const [errorType, setErrorType] = useState<ErrorType | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [processingAction, setProcessingAction] = useState<TokenAction | null>(null);
  const [confirmResult, setConfirmResult] = useState<ConfirmResp | null>(null);
  const [storedBookingId, setStoredBookingId] = useState<string | null>(null);
  const [processedTokenKey, setProcessedTokenKey] = useState<string | null>(null);
  const [rescheduleDate, setRescheduleDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [rescheduleSalespersonId, setRescheduleSalespersonId] = useState("");
  const [rescheduleSlots, setRescheduleSlots] = useState<Slot[]>([]);
  const [rescheduleSelected, setRescheduleSelected] = useState<Slot | null>(null);
  const [loadingRescheduleSlots, setLoadingRescheduleSlots] = useState(false);

  const selectedLabel = useMemo(() => {
    if (!selected) return "";
    return `${selected.start_at_utc} - ${selected.end_at_utc}`;
  }, [selected]);
  const selectedRescheduleLabel = useMemo(() => {
    if (!rescheduleSelected) return "";
    return `${rescheduleSelected.start_at_utc} - ${rescheduleSelected.end_at_utc}`;
  }, [rescheduleSelected]);

  useEffect(() => {
    const saved = window.localStorage.getItem(storageKey);
    if (saved) setStoredBookingId(saved);
  }, [storageKey]);

  useEffect(() => {
    if (actionType !== "form") return;
    let cancelled = false;
    (async () => {
      setLoadingSlots(true);
      setResultType(null);
      setErrorType(null);
      setErrorMessage("");
      setSelected(null);
      const r = await fetch(`/api/public/${tenantSlug}/availability?date=${encodeURIComponent(date)}`, {
        cache: "no-store"
      });
      const txt = await r.text();
      if (!r.ok) {
        if (!cancelled) {
          setResultType("fatal_error");
          setErrorType("request_failed");
          setErrorMessage("空き枠の取得に失敗しました。時間をおいて再度お試しください。");
        }
        if (!cancelled) setSlots([]);
        if (!cancelled) setLoadingSlots(false);
        return;
      }
      if (!cancelled) {
        setSlots(JSON.parse(txt) as Slot[]);
        setLoadingSlots(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [actionType, tenantSlug, date]);

  useEffect(() => {
    if (!tokenAction || !token) return;
    const tokenKey = [tenantSlug, tokenAction, token, queryBookingId].join(":");
    if (processedTokenKey === tokenKey) return;

    let cancelled = false;
    (async () => {
      setProcessedTokenKey(tokenKey);
      setResultType(null);
      setSuccessType(null);
      setErrorType(null);
      setErrorMessage("");

      if (tokenAction === "confirm") {
        setProcessingAction(tokenAction);
        setSubmitting(true);
        const confirmRes = await fetch(`/api/public/${tenantSlug}/confirm`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
          body: JSON.stringify({ token })
        });
        const confirmTxt = await confirmRes.text();
        if (cancelled) return;
        if (!confirmRes.ok) {
          const classified = classifyActionError(confirmRes.status, confirmTxt, tokenAction);
          setResultType(classified.resultType);
          setErrorType(classified.errorType);
          setErrorMessage(classified.message);
          setProcessingAction(null);
          setSubmitting(false);
          return;
        }

        setConfirmResult(JSON.parse(confirmTxt) as ConfirmResp);
        setResultType("success");
        setSuccessType("confirm_success");
        window.localStorage.removeItem(storageKey);
        setStoredBookingId(null);
        setProcessingAction(null);
        setSubmitting(false);
        return;
      }

      if (!queryBookingId) {
        setResultType("fatal_error");
        setErrorType("invalid_link");
        setErrorMessage("リンク情報が不足しているため処理できません。");
        setProcessingAction(null);
        setSubmitting(false);
        return;
      }

      if (tokenAction === "cancel") {
        setProcessingAction(tokenAction);
        setSubmitting(true);
        const cancelRes = await fetch(`/api/public/${tenantSlug}/bookings/${queryBookingId}/cancel`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
          body: JSON.stringify({ token })
        });
        const cancelTxt = await cancelRes.text();
        if (cancelled) return;
        if (!cancelRes.ok) {
          const classified = classifyActionError(cancelRes.status, cancelTxt, tokenAction);
          setResultType(classified.resultType);
          setErrorType(classified.errorType);
          setErrorMessage(classified.message);
          setProcessingAction(null);
          setSubmitting(false);
          return;
        }

        JSON.parse(cancelTxt) as CancelResp;
        setResultType("success");
        setSuccessType("cancel_success");
        if (storedBookingId === queryBookingId) {
          window.localStorage.removeItem(storageKey);
          setStoredBookingId(null);
        }
        setProcessingAction(null);
        setSubmitting(false);
        return;
      }

      // For reschedule, URL is for target identification only (booking_id + token).
      // Slot selection is handled in UI and submitted in request body.
      setProcessingAction(null);
      setSubmitting(false);
    })().catch((e) => {
      if (cancelled) return;
      setResultType("fatal_error");
      setErrorType("unexpected_error");
      setErrorMessage(`予期しないエラーが発生しました: ${e instanceof Error ? e.message : String(e)}`);
      setProcessingAction(null);
      setSubmitting(false);
    });

    return () => {
      cancelled = true;
    };
  }, [
    processedTokenKey,
    queryBookingId,
    storageKey,
    storedBookingId,
    tenantSlug,
    token,
    tokenAction
  ]);

  useEffect(() => {
    if (actionType !== "reschedule" || !token) return;
    if (!queryBookingId) return;
    if (rescheduleSalespersonId) return;

    let cancelled = false;
    (async () => {
      const salesRes = await fetch(`/api/public/${tenantSlug}/salespersons`, { cache: "no-store" });
      const salesTxt = await salesRes.text();
      if (cancelled) return;
      if (!salesRes.ok) {
        const classified = classifyActionError(salesRes.status, salesTxt, "reschedule");
        setResultType(classified.resultType);
        setErrorType(classified.errorType);
        setErrorMessage(classified.message);
        return;
      }

      const salespersons = JSON.parse(salesTxt) as Salesperson[];
      const selectedSalesperson = salespersons[0]?.id || "";
      if (!selectedSalesperson) {
        setResultType("retryable_error");
        setErrorType("retry_required");
        setErrorMessage("日程変更対象の担当者が見つかりません。");
        return;
      }
      setRescheduleSalespersonId(selectedSalesperson);
    })().catch((e) => {
      if (cancelled) return;
      setResultType("fatal_error");
      setErrorType("unexpected_error");
      setErrorMessage(`日程変更の初期化に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    });

    return () => {
      cancelled = true;
    };
  }, [actionType, queryBookingId, rescheduleSalespersonId, tenantSlug, token]);

  useEffect(() => {
    if (actionType !== "reschedule" || !token || !queryBookingId || !rescheduleSalespersonId) return;
    if (resultType === "success" && successType === "reschedule_success") return;

    let cancelled = false;
    (async () => {
      setLoadingRescheduleSlots(true);
      setRescheduleSelected(null);
      const res = await fetch(
        `/api/public/${tenantSlug}/availability?date=${encodeURIComponent(rescheduleDate)}&salesperson=${encodeURIComponent(rescheduleSalespersonId)}`,
        { cache: "no-store" }
      );
      const txt = await res.text();
      if (cancelled) return;
      if (!res.ok) {
        const classified = classifyActionError(res.status, txt, "reschedule");
        setResultType(classified.resultType);
        setErrorType(classified.errorType);
        setErrorMessage(classified.message);
        setRescheduleSlots([]);
        setLoadingRescheduleSlots(false);
        return;
      }

      setRescheduleSlots(JSON.parse(txt) as Slot[]);
      setLoadingRescheduleSlots(false);
    })().catch((e) => {
      if (cancelled) return;
      setResultType("fatal_error");
      setErrorType("unexpected_error");
      setErrorMessage(`日程変更候補の取得に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
      setRescheduleSlots([]);
      setLoadingRescheduleSlots(false);
    });

    return () => {
      cancelled = true;
    };
  }, [actionType, queryBookingId, rescheduleDate, rescheduleSalespersonId, successType, tenantSlug, token]);

  async function submitReschedule() {
    if (actionType !== "reschedule") return;
    if (!token || !queryBookingId) {
      setResultType("fatal_error");
      setErrorType("invalid_link");
      setErrorMessage("リンク情報が不足しているため処理できません。");
      return;
    }
    if (!rescheduleSelected) {
      setResultType("retryable_error");
      setErrorType("retry_required");
      setErrorMessage("変更先の時間枠を選択してください。");
      return;
    }

    setSubmitting(true);
    setProcessingAction("reschedule");
    setResultType(null);
    setSuccessType(null);
    setErrorType(null);
    setErrorMessage("");

    try {
      const rescheduleRes = await fetch(`/api/public/${tenantSlug}/bookings/${queryBookingId}/reschedule`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          token,
          new_start_at: rescheduleSelected.start_at_utc,
          new_end_at: rescheduleSelected.end_at_utc
        })
      });
      const rescheduleTxt = await rescheduleRes.text();
      if (!rescheduleRes.ok) {
        const classified = classifyActionError(rescheduleRes.status, rescheduleTxt, "reschedule");
        setResultType(classified.resultType);
        setErrorType(classified.errorType);
        setErrorMessage(classified.message);
        setProcessingAction(null);
        setSubmitting(false);
        return;
      }

      JSON.parse(rescheduleTxt) as RescheduleResp;
      setResultType("success");
      setSuccessType("reschedule_success");
      setProcessingAction(null);
      setSubmitting(false);
    } catch (e) {
      setResultType("fatal_error");
      setErrorType("unexpected_error");
      setErrorMessage(`日程変更に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
      setProcessingAction(null);
      setSubmitting(false);
    }
  }

  async function resendVerificationEmail() {
    if (!storedBookingId || actionType !== "confirm") return;

    setSubmitting(true);
    setResultType(null);
    setErrorType(null);
    setErrorMessage("");
    const verifyRes = await fetch(`/api/public/${tenantSlug}/verify-email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ booking_id: storedBookingId })
    });
    const verifyTxt = await verifyRes.text();
    if (!verifyRes.ok) {
      const classified = classifyActionError(verifyRes.status, verifyTxt, "confirm");
      setResultType(classified.resultType);
      setErrorType(classified.errorType);
      setErrorMessage(classified.message);
      setSubmitting(false);
      return;
    }

    JSON.parse(verifyTxt) as VerifyResp;
    setResultType("success");
    setSuccessType("verification_sent");
    setSubmitting(false);
  }

  async function submitBooking() {
    if (actionType !== "form") return;
    if (!selected) {
      setResultType("retryable_error");
      setErrorType("retry_required");
      setErrorMessage("時間枠を選択してください。");
      return;
    }
    if (!name.trim()) {
      setResultType("retryable_error");
      setErrorType("retry_required");
      setErrorMessage("お名前を入力してください。");
      return;
    }
    if (!email.trim()) {
      setResultType("retryable_error");
      setErrorType("retry_required");
      setErrorMessage("メールアドレスを入力してください。");
      return;
    }

    setResultType(null);
    setSuccessType(null);
    setErrorType(null);
    setErrorMessage("");
    setSubmitting(true);

    try {
      const holdKey = crypto.randomUUID();
      const verifyKey = crypto.randomUUID();

      const holdPayload = {
        start_at: selected.start_at_utc,
        end_at: selected.end_at_utc,
        booking_mode: bookingMode,
        public_notes: publicNotes,
        customer: { email: email.trim(), name: name.trim() }
      };

      const holdRes = await fetch(`/api/public/${tenantSlug}/holds`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": holdKey },
        body: JSON.stringify(holdPayload)
      });
      const holdTxt = await holdRes.text();
      if (!holdRes.ok) {
        const classified = classifyActionError(holdRes.status, holdTxt, "confirm");
        setResultType(classified.resultType);
        setErrorType(classified.errorType);
        setErrorMessage(classified.message);
        setSubmitting(false);
        return;
      }
      const hold = JSON.parse(holdTxt) as HoldResp;
      window.localStorage.setItem(storageKey, hold.id);
      setStoredBookingId(hold.id);

      const verifyRes = await fetch(`/api/public/${tenantSlug}/verify-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": verifyKey },
        body: JSON.stringify({ booking_id: hold.id })
      });
      const verifyTxt = await verifyRes.text();
      if (!verifyRes.ok) {
        const classified = classifyActionError(verifyRes.status, verifyTxt, "confirm");
        setResultType(classified.resultType);
        setErrorType(classified.errorType);
        setErrorMessage(classified.message);
        setSubmitting(false);
        return;
      }

      JSON.parse(verifyTxt) as VerifyResp;
      setResultType("success");
      setSuccessType("verification_sent");
      setSubmitting(false);
    } catch (e) {
      setResultType("fatal_error");
      setErrorType("unexpected_error");
      setErrorMessage(`予約に失敗しました。 (${e instanceof Error ? e.message : String(e)})`);
      setSubmitting(false);
    }
  }

  if (actionType !== "form") {
    const canResendVerification =
      actionType === "confirm" && storedBookingId !== null && resultType === "retryable_error";
    const canRenderRescheduleForm = actionType === "reschedule" && !!queryBookingId;
    const processingText =
      actionType === "confirm"
        ? "予約を確認しています..."
        : actionType === "cancel"
          ? "予約をキャンセルしています..."
          : "日程変更を処理しています...";
    const actionTitle =
      actionType === "confirm" ? "予約確認" : actionType === "cancel" ? "予約キャンセル" : "日程変更";

    if (resultType === "success" && successType === "confirm_success") {
      return (
        <div className="mx-auto max-w-2xl p-6 space-y-6">
          <h1 className="text-2xl font-semibold">予約完了</h1>
          <p className="rounded border p-3 text-sm">
            予約を受け付けました。確認メールを送信しました。届かない場合は迷惑メールフォルダをご確認ください。
          </p>
          {confirmResult?.cancel_url ? (
            <p className="text-sm">
              キャンセル:{" "}
              <a className="underline" href={confirmResult.cancel_url}>
                {confirmResult.cancel_url}
              </a>
            </p>
          ) : null}
          {confirmResult?.reschedule_url ? (
            <p className="text-sm">
              変更:{" "}
              <a className="underline" href={confirmResult.reschedule_url}>
                {confirmResult.reschedule_url}
              </a>
            </p>
          ) : null}
        </div>
      );
    }

    if (resultType === "success" && successType === "cancel_success") {
      return (
        <div className="mx-auto max-w-2xl p-6 space-y-6">
          <h1 className="text-2xl font-semibold">キャンセル完了</h1>
          <p className="rounded border p-3 text-sm">予約のキャンセルが完了しました。</p>
        </div>
      );
    }

    if (resultType === "success" && successType === "reschedule_success") {
      return (
        <div className="mx-auto max-w-2xl p-6 space-y-6">
          <h1 className="text-2xl font-semibold">日程変更完了</h1>
          <p className="rounded border p-3 text-sm">予約の日程変更が完了しました。</p>
        </div>
      );
    }

    return (
      <div className="mx-auto max-w-2xl p-6 space-y-6">
        <h1 className="text-2xl font-semibold">{actionTitle}</h1>
        <p className="rounded border p-3 text-sm">
          {submitting && processingAction === actionType
            ? processingText
            : successType === "verification_sent"
              ? "確認メールを再送しました。新しいメール内のリンクをご利用ください。"
              : actionType === "reschedule"
                ? "変更先の時間枠を選択してください。"
                : "メール内のリンクを処理しています。"}
        </p>
        {resultType && resultType !== "success" && errorType ? (
          <pre className="rounded border p-3 text-sm text-red-700 whitespace-pre-wrap">
            [{formatActionErrorLabel(errorType)}] {errorMessage}
          </pre>
        ) : null}
        {canRenderRescheduleForm ? (
          <section className="space-y-3">
            <label className="block">
              <div className="text-sm">変更日</div>
              <input
                className="w-full border rounded p-2"
                type="date"
                value={rescheduleDate}
                onChange={(e) => setRescheduleDate(e.target.value)}
              />
            </label>
            <div className="text-sm font-medium">変更可能な時間枠</div>
            {loadingRescheduleSlots ? <div className="text-sm">読み込み中...</div> : null}
            {loadingRescheduleSlots ? null : (
              <div className="grid grid-cols-1 gap-2">
                {rescheduleSlots.map((s) => {
                  const active =
                    rescheduleSelected?.start_at_utc === s.start_at_utc && rescheduleSelected?.end_at_utc === s.end_at_utc;
                  return (
                    <button
                      key={`${s.start_at_utc}-${s.end_at_utc}`}
                      className={`border rounded p-3 text-left ${active ? "border-black" : "border-gray-300"}`}
                      onClick={() => setRescheduleSelected(s)}
                      type="button"
                    >
                      <div className="text-sm">{s.start_at_utc}</div>
                      <div className="text-sm">{s.end_at_utc}</div>
                    </button>
                  );
                })}
              </div>
            )}
            {!loadingRescheduleSlots && rescheduleSlots.length === 0 ? (
              <p className="text-sm">変更可能な時間枠が見つかりませんでした。日付を変更して再度お試しください。</p>
            ) : null}
            {selectedRescheduleLabel ? <div className="text-sm">選択中: {selectedRescheduleLabel}</div> : null}
            <button
              className="rounded bg-black text-white px-4 py-2 disabled:opacity-50"
              disabled={submitting || loadingRescheduleSlots || !rescheduleSelected}
              onClick={submitReschedule}
              type="button"
            >
              {submitting && processingAction === "reschedule" ? "処理中..." : "この枠に変更する"}
            </button>
          </section>
        ) : null}
        {canResendVerification ? (
          <button
            className="rounded bg-black text-white px-4 py-2 disabled:opacity-50"
            disabled={submitting}
            onClick={resendVerificationEmail}
            type="button"
          >
            確認メールを再送する
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl p-6 space-y-6">
      <h1 className="text-2xl font-semibold">予約フォーム ({tenantSlug})</h1>

      {resultType && resultType !== "success" ? (
        <pre className="rounded border p-3 text-sm text-red-700 whitespace-pre-wrap">
          [{formatActionErrorLabel(errorType)}] {errorMessage}
        </pre>
      ) : null}
      {resultType === "success" && successType === "verification_sent" ? (
        <p className="rounded border p-3 text-sm">
          確認メールを送信しました。メール内のリンクから予約を確定してください。
        </p>
      ) : null}

      <section className="space-y-2">
        <label className="block">
          <div className="text-sm">日付</div>
          <input className="w-full border rounded p-2" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
      </section>

      <section className="space-y-2">
        <div className="text-sm font-medium">時間枠</div>
        {loadingSlots ? <div className="text-sm">読み込み中...</div> : null}
        <div className="grid grid-cols-1 gap-2">
          {slots.map((s) => {
            const active = selected?.start_at_utc === s.start_at_utc && selected?.end_at_utc === s.end_at_utc;
            return (
              <button
                key={`${s.start_at_utc}-${s.end_at_utc}`}
                className={`border rounded p-3 text-left ${active ? "border-black" : "border-gray-300"}`}
                onClick={() => setSelected(s)}
                type="button"
              >
                <div className="text-sm">{s.start_at_utc}</div>
                <div className="text-sm">{s.end_at_utc}</div>
              </button>
            );
          })}
        </div>
      </section>

      <section className="space-y-2">
        <div className="text-sm font-medium">お客様情報</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <input className="border rounded p-2" placeholder="お名前" value={name} onChange={(e) => setName(e.target.value)} />
          <input className="border rounded p-2" placeholder="メールアドレス" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <input
          className="border rounded p-2 w-full"
          placeholder="相談内容（任意・1行）"
          value={publicNotes}
          onChange={(e) => setPublicNotes(e.target.value)}
        />
        <div className="flex gap-4 text-sm">
          <label className="inline-flex items-center gap-2">
            <input type="radio" checked={bookingMode === "online"} onChange={() => setBookingMode("online")} />
            オンライン
          </label>
          <label className="inline-flex items-center gap-2">
            <input type="radio" checked={bookingMode === "offline"} onChange={() => setBookingMode("offline")} />
            オフライン
          </label>
        </div>
      </section>

      <section className="space-y-3">
        {selectedLabel ? <div className="text-sm">選択中: {selectedLabel}</div> : null}
        <button
          className="rounded bg-black text-white px-4 py-2 disabled:opacity-50"
          disabled={submitting || loadingSlots || !selected || !name.trim() || !email.trim()}
          onClick={submitBooking}
          type="button"
        >
          {submitting ? "処理中..." : "予約する"}
        </button>
      </section>
    </div>
  );
}
