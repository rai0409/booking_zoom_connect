import PublicBookingFormView from "./PublicBookingFormView";
import { classifyPublicApiError, messageFromErrorCode } from "./errors";
import { todayJstYmd } from "./formatters";
import { normalizeYmd, readSearchParam } from "./helpers";
import { fetchAvailabilityServer, parseSlots } from "./publicBookingApi";
import type { BookingMode, PublicFlashMessage, Slot } from "./types";

export const dynamic = "force-dynamic";

type PageProps = {
  params: { tenantSlug: string };
  searchParams?: Record<string, string | string[] | undefined>;
};

export default async function PublicTenantPage({ params, searchParams }: PageProps) {
  const today = todayJstYmd();
  const date = normalizeYmd(readSearchParam(searchParams?.date), today);

  const status = readSearchParam(searchParams?.status);
  const errorCode = readSearchParam(searchParams?.error);

  const defaultName = readSearchParam(searchParams?.name).slice(0, 120);
  const defaultEmail = readSearchParam(searchParams?.email).slice(0, 320);
  const defaultPublicNotes = readSearchParam(searchParams?.public_notes).slice(0, 500);
  const defaultBookingMode: BookingMode = readSearchParam(searchParams?.booking_mode) === "offline" ? "offline" : "online";

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
      ? messageFromErrorCode("config_error", "availability")
      : messageFromErrorCode("request_failed", "availability");
  }

  let flashMessage: PublicFlashMessage | null = null;
  if (status === "verification_sent") {
    flashMessage = {
      tone: "success",
      text: "確認メールを送信しました。メール内リンクを開くと予約が確定します。"
    };
  }
  if (status === "book_error") {
    flashMessage = {
      tone: "error",
      text: messageFromErrorCode(errorCode || "unknown", "book")
    };
  }

  const debugEnabled = readSearchParam(searchParams?.debug) === "1";

  return (
    <PublicBookingFormView
      tenantSlug={params.tenantSlug}
      date={date}
      slots={slots}
      flashMessage={flashMessage}
      availabilityError={availabilityError}
      defaultName={defaultName}
      defaultEmail={defaultEmail}
      defaultPublicNotes={defaultPublicNotes}
      defaultBookingMode={defaultBookingMode}
      debugInfo={
        debugEnabled
          ? {
              tenantSlug: params.tenantSlug,
              date,
              slotsCount: slots.length,
              availabilityError,
              status,
              errorCode,
              appUrlConfigured: Boolean(process.env.APP_URL)
            }
          : undefined
      }
    />
  );
}
