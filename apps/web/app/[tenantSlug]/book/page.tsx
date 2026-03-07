"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";

type Slot = { start_at_utc: string; end_at_utc: string };

type HoldResponse = {
  id: string;
  start_at_utc: string;
  end_at_utc: string;
};

type VerifyResponse = { status: string; token?: string };
type ErrorResponse = { message?: string };

export default function BookingPage({ params }: { params: { tenantSlug: string } }) {
  const searchParams = useSearchParams();
  const salespersonId = searchParams.get("salesperson") || "";
  const date = searchParams.get("date") || new Date().toISOString().slice(0, 10);
  const storageKey = useMemo(() => `public-booking:${params.tenantSlug}:booking_id`, [params.tenantSlug]);

  const [slots, setSlots] = useState<Slot[]>([]);
  const [selectedSlot, setSelectedSlot] = useState<Slot | null>(null);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [company, setCompany] = useState("");
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [awaitingEmail, setAwaitingEmail] = useState(false);
  const [error, setError] = useState("");
  const [verifyUrl, setVerifyUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const qs = new URLSearchParams({ date });
    if (salespersonId) qs.set("salesperson", salespersonId);

    (async () => {
      setLoadingSlots(true);
      setError("");
      setSelectedSlot(null);
      try {
        const res = await fetch(`/api/public/${params.tenantSlug}/availability?${qs.toString()}`, {
          cache: "no-store"
        });
        const text = await res.text();
        if (cancelled) return;
        if (!res.ok) {
          setSlots([]);
          setError("時間枠の読み込みに失敗しました。時間をおいて再試行してください。");
          setLoadingSlots(false);
          return;
        }
        setSlots(JSON.parse(text) as Slot[]);
      } catch {
        if (cancelled) return;
        setSlots([]);
        setError("時間枠の読み込みに失敗しました。時間をおいて再試行してください。");
      } finally {
        if (!cancelled) setLoadingSlots(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [date, params.tenantSlug, salespersonId]);

  const holdPayload = useMemo(() => {
    if (!selectedSlot) return null;
    return {
      ...(salespersonId ? { salesperson_id: salespersonId } : {}),
      start_at: selectedSlot.start_at_utc,
      end_at: selectedSlot.end_at_utc,
      customer: { email, name, company }
    };
  }, [company, email, name, salespersonId, selectedSlot]);

  async function submitBooking() {
    if (!selectedSlot) {
      setError("時間枠を選択してください。");
      return;
    }
    if (!email.trim()) {
      setError("メールアドレスを入力してください。");
      return;
    }

    setSubmitting(true);
    setAwaitingEmail(false);
    setVerifyUrl(null);
    setError("");

    let hold: HoldResponse;
    try {
      const holdRes = await fetch(`/api/public/${params.tenantSlug}/holds`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID()
        },
        body: JSON.stringify(holdPayload)
      });
      const holdText = await holdRes.text();
      if (!holdRes.ok) {
        let serverMessage = "";
        try {
          serverMessage = ((JSON.parse(holdText) as ErrorResponse).message || "").trim();
        } catch {
          serverMessage = "";
        }
        if (holdRes.status === 409) {
          setError("予約枠が埋まりました。別の時間を選んでください。");
        } else if (holdRes.status === 400) {
          setError(serverMessage || "入力内容を確認してください。");
        } else {
          setError("一時的に失敗しました。時間をおいて再試行してください。");
        }
        setSubmitting(false);
        return;
      }
      hold = JSON.parse(holdText) as HoldResponse;
    } catch {
      setError("一時的に失敗しました。時間をおいて再試行してください。");
      setSubmitting(false);
      return;
    }

    window.localStorage.setItem(storageKey, hold.id);

    try {
      const verifyRes = await fetch(`/api/public/${params.tenantSlug}/verify-email`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID()
        },
        body: JSON.stringify({ booking_id: hold.id })
      });
      const verifyText = await verifyRes.text();
      if (!verifyRes.ok) {
        setError("確認メールの送信に失敗しました。再試行してください。");
        setSubmitting(false);
        return;
      }

      const verify = JSON.parse(verifyText) as VerifyResponse;
      setVerifyUrl(
        process.env.NODE_ENV !== "production" && verify.token
          ? `/public/${encodeURIComponent(params.tenantSlug)}?token=${encodeURIComponent(verify.token)}`
          : null
      );
      setAwaitingEmail(true);
    } catch {
      setError("確認メールの送信に失敗しました。再試行してください。");
    } finally {
      setSubmitting(false);
    }
  }

  if (awaitingEmail) {
    return (
      <main className="mx-auto max-w-2xl p-6 space-y-6">
        <h1 className="text-2xl font-semibold">確認メールを送信しました</h1>
        <p className="rounded border p-3 text-sm">
          メールのリンクをクリックすると予約が確定します。届かない場合は迷惑メールフォルダもご確認ください。
        </p>
        <p className="rounded border p-3 text-sm">メール内リンクをクリックするとこのページで確定します</p>
        {verifyUrl ? (
          <p className="rounded border p-3 text-sm">
            Dev verify link:{" "}
            <a className="underline" href={verifyUrl}>
              {verifyUrl}
            </a>
          </p>
        ) : null}
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-2xl p-6 space-y-6">
      <h1 className="text-2xl font-semibold">予約フォーム</h1>
      <p className="rounded border p-3 text-sm">日付: {date}</p>
      {salespersonId ? <p className="rounded border p-3 text-sm">担当者: {salespersonId}</p> : null}
      {error ? <p className="rounded border p-3 text-sm text-red-700">{error}</p> : null}

      <section className="space-y-2">
        <h2 className="text-sm font-medium">時間枠</h2>
        {loadingSlots ? <p className="rounded border p-3 text-sm">読み込み中...</p> : null}
        {!loadingSlots && slots.length === 0 ? <p className="rounded border p-3 text-sm">選択できる時間枠がありません。</p> : null}
        <div className="grid grid-cols-1 gap-2">
          {slots.map((slot) => {
            const active = selectedSlot?.start_at_utc === slot.start_at_utc;
            return (
              <button
                key={slot.start_at_utc}
                className={`rounded border p-3 text-left text-sm ${active ? "border-black" : "border-gray-300"}`}
                onClick={() => setSelectedSlot(slot)}
                type="button"
              >
                <div>{new Date(slot.start_at_utc).toLocaleString()}</div>
                <div className="text-xs text-gray-600">{slot.end_at_utc}</div>
              </button>
            );
          })}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium">お客様情報</h2>
        <input
          className="w-full rounded border p-2"
          placeholder="メールアドレス"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <input
          className="w-full rounded border p-2"
          placeholder="お名前（任意）"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          className="w-full rounded border p-2"
          placeholder="会社名（任意）"
          value={company}
          onChange={(e) => setCompany(e.target.value)}
        />
        <button
          className="rounded bg-black text-white px-4 py-2 disabled:opacity-50"
          type="button"
          onClick={submitBooking}
          disabled={!holdPayload || !email.trim() || submitting}
        >
          {submitting ? "送信中..." : "確認メールを送信する"}
        </button>
      </section>
    </main>
  );
}
