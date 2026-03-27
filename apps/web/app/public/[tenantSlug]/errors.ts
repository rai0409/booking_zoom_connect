import { PublicApiErrorSchema } from "./types";
import type { PublicApiError, PublicApiErrorPayload, PublicErrorCode, PublicErrorContext } from "./types";

function normalizeApiMessage(payload: PublicApiErrorPayload): string {
  if (Array.isArray(payload.message)) return payload.message.join(", ");
  if (typeof payload.message === "string") return payload.message;
  if (typeof payload.error === "string") return payload.error;
  return "";
}

function parseApiErrorPayload(raw: string): PublicApiErrorPayload | null {
  if (!raw) return null;

  try {
    const parsedJson = JSON.parse(raw) as unknown;
    const parsed = PublicApiErrorSchema.safeParse(parsedJson);
    if (!parsed.success) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

export function extractApiError(raw: string): { message: string; code: string } {
  const payload = parseApiErrorPayload(raw);
  if (!payload) {
    return {
      message: raw,
      code: ""
    };
  }

  return {
    message: normalizeApiMessage(payload),
    code: typeof payload.code === "string" ? payload.code : ""
  };
}

function mapErrorCodeToMessage(errorCode: PublicErrorCode, context: PublicErrorContext): string {
  switch (errorCode) {
    case "invalid_input":
      return "入力内容を確認してください。";
    case "invalid_token":
      return "リンク情報が無効です。";
    case "expired":
      return context === "availability"
        ? "表示中の空き枠情報の有効期限が切れました。更新してください。"
        : "有効期限が切れました。最初からやり直してください。";
    case "slot_unavailable":
      return context === "availability"
        ? "空き枠情報を更新してください。"
        : "選択した時間枠は利用できません。別の時間枠を選択してください。";
    case "already_processed":
      return "同じ操作が短時間に重複しました。少し待ってから再試行してください。";
    case "config_error":
      return "サーバー設定が不足しています。管理者へ連絡してください。";
    case "request_failed":
      return "一時的に処理できません。時間をおいて再度お試しください。";
    case "not_found":
      return context === "availability"
        ? "対象の公開予約ページが見つかりません。"
        : "対象データが見つかりません。";
    case "unknown":
    default:
      return "処理に失敗しました。";
  }
}

function mapKnownApiCode(code: string): PublicErrorCode | null {
  switch (code) {
    case "INVALID_INPUT":
    case "VALIDATION_ERROR":
    case "BAD_REQUEST":
      return "invalid_input";
    case "INVALID_TOKEN":
      return "invalid_token";
    case "HOLD_EXPIRED":
    case "TOKEN_EXPIRED":
    case "EXPIRED":
      return "expired";
    case "SLOT_UNAVAILABLE":
    case "SLOT_ALREADY_TAKEN":
      return "slot_unavailable";
    case "ALREADY_PROCESSED":
    case "IDEMPOTENCY_REPLAY":
    case "IDEMPOTENCY_CONFLICT":
      return "already_processed";
    case "CONFIG_ERROR":
      return "config_error";
    case "NOT_FOUND":
    case "TENANT_NOT_FOUND":
    case "BOOKING_NOT_FOUND":
      return "not_found";
    default:
      return null;
  }
}

function fromMessage(message: string): PublicErrorCode | null {
  const normalized = message.toLowerCase();

  if (
    normalized.includes("invalid") ||
    normalized.includes("required") ||
    normalized.includes("validation")
  ) {
    return "invalid_input";
  }

  if (normalized.includes("token")) {
    return "invalid_token";
  }

  if (
    normalized.includes("expired") ||
    normalized.includes("期限") ||
    normalized.includes("deadline passed")
  ) {
    return "expired";
  }

  if (
    normalized.includes("slot already taken") ||
    normalized.includes("slot unavailable") ||
    normalized.includes("already booked")
  ) {
    return "slot_unavailable";
  }

  if (
    normalized.includes("already used") ||
    normalized.includes("already processed") ||
    normalized.includes("already confirmed")
  ) {
    return "already_processed";
  }

  if (normalized.includes("not found")) {
    return "not_found";
  }

  return null;
}

function fromStatus(status: number): PublicErrorCode {
  if (status === 400 || status === 422) return "invalid_input";
  if (status === 401 || status === 403) return "invalid_token";
  if (status === 404) return "not_found";
  if (status === 409) return "slot_unavailable";
  if (status >= 500) return "request_failed";
  return "unknown";
}

export function classifyPublicApiError(
  status: number,
  raw: string,
  context: PublicErrorContext
): PublicApiError {
  const { message, code } = extractApiError(raw);
  const normalizedCode = code.trim().toUpperCase();

  const byCode = mapKnownApiCode(normalizedCode);
  if (byCode) {
    return { code: byCode, message: mapErrorCodeToMessage(byCode, context) };
  }

  const byMessage = fromMessage(message);
  if (byMessage) {
    return { code: byMessage, message: mapErrorCodeToMessage(byMessage, context) };
  }

  const byStatus = fromStatus(status);
  return { code: byStatus, message: mapErrorCodeToMessage(byStatus, context) };
}

export function messageFromErrorCode(code: string | null | undefined, context: PublicErrorContext): string {
  const normalized = (code || "").trim();
  const supported: PublicErrorCode[] = [
    "invalid_input",
    "invalid_token",
    "expired",
    "slot_unavailable",
    "already_processed",
    "config_error",
    "request_failed",
    "not_found",
    "unknown"
  ];

  if ((supported as string[]).includes(normalized)) {
    return mapErrorCodeToMessage(normalized as PublicErrorCode, context);
  }

  return mapErrorCodeToMessage("unknown", context);
}
