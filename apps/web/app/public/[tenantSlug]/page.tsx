"use client";

import { useEffect, useMemo, useState } from "react";

type Slot = { start_at_utc: string; end_at_utc: string };
type HoldResp = { id: string; status: string; start_at_utc: string; end_at_utc: string; hold: { expires_at_utc: string } };
type VerifyResp = { status: string; token?: string };
type ConfirmResp = { status: string; booking_id: string; cancel_url?: string; reschedule_url?: string };

export default function PublicBookingPage({ params }: { params: { tenantSlug: string } }) {
  const tenantSlug = params.tenantSlug;

  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [slots, setSlots] = useState<Slot[]>([]);
  const [selected, setSelected] = useState<Slot | null>(null);

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [publicNotes, setPublicNotes] = useState("");
  const [bookingMode, setBookingMode] = useState<"online" | "offline">("online");

  const [loadingSlots, setLoadingSlots] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState<ConfirmResp | null>(null);

  const selectedLabel = useMemo(() => {
    if (!selected) return "";
    return `${selected.start_at_utc} - ${selected.end_at_utc}`;
  }, [selected]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadingSlots(true);
      setErr("");
      setSelected(null);
      const r = await fetch(`/api/public/${tenantSlug}/availability?date=${encodeURIComponent(date)}`, {
        cache: "no-store"
      });
      const txt = await r.text();
      if (!r.ok) {
        if (!cancelled) setErr(`availability failed: ${r.status} ${txt}`);
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
  }, [tenantSlug, date]);

  async function submitBooking() {
    if (!selected) {
      setErr("時間枠を選択してください");
      return;
    }
    if (!name.trim()) {
      setErr("お名前を入力してください");
      return;
    }
    if (!email.trim()) {
      setErr("メールアドレスを入力してください");
      return;
    }

    setErr("");
    setSubmitting(true);

    try {
      const holdKey = crypto.randomUUID();
      const verifyKey = crypto.randomUUID();
      const confirmKey = crypto.randomUUID();

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
        setErr(`予約枠の確保に失敗しました: ${holdRes.status} ${holdTxt}`);
        setSubmitting(false);
        return;
      }
      const hold = JSON.parse(holdTxt) as HoldResp;

      const verifyRes = await fetch(`/api/public/${tenantSlug}/verify-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": verifyKey },
        body: JSON.stringify({ booking_id: hold.id })
      });
      const verifyTxt = await verifyRes.text();
      if (!verifyRes.ok) {
        setErr(`確認メール処理に失敗しました: ${verifyRes.status} ${verifyTxt}`);
        setSubmitting(false);
        return;
      }

      const verify = JSON.parse(verifyTxt) as VerifyResp;
      const confirmPayload = verify.token ? { token: verify.token } : { booking_id: hold.id };

      const confirmRes = await fetch(`/api/public/${tenantSlug}/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": confirmKey },
        body: JSON.stringify(confirmPayload)
      });
      const confirmTxt = await confirmRes.text();
      if (!confirmRes.ok) {
        setErr(`予約確定に失敗しました: ${confirmRes.status} ${confirmTxt}`);
        setSubmitting(false);
        return;
      }

      setDone(JSON.parse(confirmTxt) as ConfirmResp);
      setSubmitting(false);
    } catch (e) {
      setErr(`予約に失敗しました。別の時間を選んでください。 (${e instanceof Error ? e.message : String(e)})`);
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <div className="mx-auto max-w-2xl p-6 space-y-6">
        <h1 className="text-2xl font-semibold">予約完了</h1>
        <p className="rounded border p-3 text-sm">
          予約を受け付けました。確認メールを送信しました。届かない場合は迷惑メールフォルダをご確認ください。
        </p>
        {done.cancel_url ? (
          <p className="text-sm">
            キャンセル:{" "}
            <a className="underline" href={done.cancel_url}>
              {done.cancel_url}
            </a>
          </p>
        ) : null}
        {done.reschedule_url ? (
          <p className="text-sm">
            変更:{" "}
            <a className="underline" href={done.reschedule_url}>
              {done.reschedule_url}
            </a>
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl p-6 space-y-6">
      <h1 className="text-2xl font-semibold">予約フォーム ({tenantSlug})</h1>

      {err && <pre className="rounded border p-3 text-sm text-red-700 whitespace-pre-wrap">{err}</pre>}

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
