"use client";

import { useEffect, useMemo, useState } from "react";

type Salesperson = { id: string; display_name: string; timezone: string };
type Slot = { start_at_utc: string; end_at_utc: string };
type HoldResp = { id: string; status: string; start_at_utc: string; end_at_utc: string; hold: { expires_at_utc: string } };
type VerifyResp = { status: string; token: string };
type ConfirmResp = { status: string; booking_id: string };

export default function PublicBookingPage({ params }: { params: { tenantSlug: string } }) {
  const tenantSlug = params.tenantSlug;

  const [salespersons, setSalespersons] = useState<Salesperson[]>([]);
  const [salespersonId, setSalespersonId] = useState("");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [slots, setSlots] = useState<Slot[]>([]);
  const [selected, setSelected] = useState<Slot | null>(null);

  const [email, setEmail] = useState("");
  const [name, setName] = useState("");

  const [hold, setHold] = useState<HoldResp | null>(null);
  const [token, setToken] = useState("");
  const [confirmed, setConfirmed] = useState<ConfirmResp | null>(null);

  const [holdKey] = useState(() => crypto.randomUUID());
  const [verifyKey] = useState(() => crypto.randomUUID());
  const [confirmKey] = useState(() => crypto.randomUUID());

  const [err, setErr] = useState("");

  useEffect(() => {
    (async () => {
      setErr("");
      const r = await fetch(`/api/public/${tenantSlug}/salespersons`, { cache: "no-store" });
      if (!r.ok) { setErr(`salespersons failed: ${r.status}`); return; }
      const data = (await r.json()) as Salesperson[];
      setSalespersons(data);
      if (!salespersonId && data[0]?.id) setSalespersonId(data[0].id);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantSlug]);

  const canLoadSlots = useMemo(() => !!salespersonId && !!date, [salespersonId, date]);

  async function loadSlots() {
    setErr("");
    setSelected(null);
    setHold(null);
    setToken("");
    setConfirmed(null);

    const url = `/api/public/${tenantSlug}/availability?salesperson=${encodeURIComponent(salespersonId)}&date=${encodeURIComponent(date)}`;
    const r = await fetch(url, { cache: "no-store" });
    const txt = await r.text();
    if (!r.ok) { setErr(`availability failed: ${r.status} ${txt}`); return; }
    setSlots(JSON.parse(txt) as Slot[]);
  }

  async function createHold() {
    if (!selected) return;
    if (!email) { setErr("email required"); return; }
    setErr("");

    // IMPORTANT: holds expects start_at/end_at (not *_utc)
    const payload = {
      salesperson_id: salespersonId,
      start_at: selected.start_at_utc,
      end_at: selected.end_at_utc,
      customer: { email, name },
    };

    const r = await fetch(`/api/public/${tenantSlug}/holds`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": holdKey },
      body: JSON.stringify(payload),
    });

    const txt = await r.text();
    if (!r.ok) { setErr(`hold failed: ${r.status} ${txt}`); return; }
    setHold(JSON.parse(txt) as HoldResp);
  }

  async function verifyEmail() {
    if (!hold) return;
    setErr("");

    const payload = { booking_id: hold.id, email };

    const r = await fetch(`/api/public/${tenantSlug}/verify-email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": verifyKey },
      body: JSON.stringify(payload),
    });

    const txt = await r.text();
    if (!r.ok) { setErr(`verify failed: ${r.status} ${txt}`); return; }
    const data = JSON.parse(txt) as VerifyResp;
    setToken(data.token);
  }

  async function confirm() {
    if (!hold || !token) return;
    setErr("");

    const payload = { booking_id: hold.id, token };

    const r = await fetch(`/api/public/${tenantSlug}/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": confirmKey },
      body: JSON.stringify(payload),
    });

    const txt = await r.text();
    if (!r.ok) { setErr(`confirm failed: ${r.status} ${txt}`); return; }
    setConfirmed(JSON.parse(txt) as ConfirmResp);
  }

  return (
    <div className="mx-auto max-w-2xl p-6 space-y-6">
      <h1 className="text-2xl font-semibold">Public booking ({tenantSlug})</h1>

      {err && <pre className="rounded border p-3 text-sm text-red-700 whitespace-pre-wrap">{err}</pre>}

      <section className="space-y-2">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 items-end">
          <label className="block">
            <div className="text-sm">Salesperson</div>
            <select className="w-full border rounded p-2" value={salespersonId} onChange={(e) => setSalespersonId(e.target.value)}>
              {salespersons.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.display_name} ({s.timezone})
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <div className="text-sm">Date</div>
            <input className="w-full border rounded p-2" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>

          <button className="rounded bg-black text-white px-4 py-2 disabled:opacity-50" disabled={!canLoadSlots} onClick={loadSlots}>
            Load slots
          </button>
        </div>
      </section>

      <section className="space-y-2">
        <div className="text-sm font-medium">Slots</div>
        <div className="grid grid-cols-1 gap-2">
          {slots.map((s) => {
            const active = selected?.start_at_utc === s.start_at_utc && selected?.end_at_utc === s.end_at_utc;
            return (
              <button
                key={`${s.start_at_utc}-${s.end_at_utc}`}
                className={`border rounded p-3 text-left ${active ? "border-black" : "border-gray-300"}`}
                onClick={() => setSelected(s)}
              >
                <div className="text-sm">{s.start_at_utc}</div>
                <div className="text-sm">{s.end_at_utc}</div>
              </button>
            );
          })}
        </div>
      </section>

      <section className="space-y-2">
        <div className="text-sm font-medium">Customer</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <input className="border rounded p-2" placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <input className="border rounded p-2" placeholder="name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex gap-2 flex-wrap">
          <button className="rounded bg-black text-white px-4 py-2 disabled:opacity-50" disabled={!selected || !email || !!hold} onClick={createHold}>
            Hold
          </button>
          <button className="rounded bg-black text-white px-4 py-2 disabled:opacity-50" disabled={!hold || !!token} onClick={verifyEmail}>
            Verify email
          </button>
          <button className="rounded bg-black text-white px-4 py-2 disabled:opacity-50" disabled={!hold || !token || !!confirmed} onClick={confirm}>
            Confirm
          </button>
        </div>

        {hold && <pre className="rounded border p-3 text-xs whitespace-pre-wrap">hold: {JSON.stringify(hold, null, 2)}</pre>}
        {token && <pre className="rounded border p-3 text-xs whitespace-pre-wrap">token: {token.slice(0, 32)}...</pre>}
        {confirmed && <pre className="rounded border p-3 text-xs whitespace-pre-wrap">confirmed: {JSON.stringify(confirmed, null, 2)}</pre>}
      </section>
    </div>
  );
}
