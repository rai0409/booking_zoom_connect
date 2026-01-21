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

export default function BookingPage({ params }: { params: { tenantSlug: string } }) {
  const searchParams = useSearchParams();
  const salespersonId = searchParams.get("salesperson") || "";
  const date = searchParams.get("date") || new Date().toISOString().slice(0, 10);
  const apiBase = process.env.NEXT_PUBLIC_API_BASE || "http://localhost:4000";

  const [slots, setSlots] = useState<Slot[]>([]);
  const [selectedSlot, setSelectedSlot] = useState<Slot | null>(null);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [company, setCompany] = useState("");
  const [hold, setHold] = useState<HoldResponse | null>(null);
  const [verifyToken, setVerifyToken] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    if (!salespersonId || !date) return;
    fetch(`${apiBase}/v1/public/${params.tenantSlug}/availability?salesperson=${encodeURIComponent(salespersonId)}&date=${encodeURIComponent(date)}`)
      .then((res) => res.json())
      .then((data) => setSlots(data))
      .catch(() => setSlots([]));
  }, [apiBase, date, params.tenantSlug, salespersonId]);

  const holdPayload = useMemo(() => {
    if (!selectedSlot) return null;
    return {
      salesperson_id: salespersonId,
      start_at: selectedSlot.start_at_utc,
      end_at: selectedSlot.end_at_utc,
      customer: { email, name, company }
    };
  }, [company, email, name, salespersonId, selectedSlot]);

  async function createHold() {
    if (!holdPayload) return;
    setStatus("Creating hold...");
    const res = await fetch(`${apiBase}/v1/public/${params.tenantSlug}/holds`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID()
      },
      body: JSON.stringify(holdPayload)
    });

    const data = (await res.json()) as HoldResponse;
    setHold(data);
    setStatus(res.ok ? "Hold created" : "Failed to create hold");
  }

  async function sendVerification() {
    if (!hold) return;
    setStatus("Sending verification...");
    const res = await fetch(`${apiBase}/v1/public/${params.tenantSlug}/auth/verify-email`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID()
      },
      body: JSON.stringify({ booking_id: hold.id })
    });

    const data = (await res.json()) as VerifyResponse;
    setVerifyToken(data.token || null);
    setStatus(res.ok ? "Verification sent" : "Failed to send verification");
  }

  return (
    <main style={{ padding: 24, fontFamily: "ui-sans-serif, system-ui" }}>
      <h1>Book a time</h1>
      <p>Tenant: {params.tenantSlug}</p>
      <p>Salesperson: {salespersonId || "(missing)"}</p>
      <p>Date: {date}</p>

      <section>
        <h2>Available slots</h2>
        {slots.length === 0 ? (
          <p>No slots loaded.</p>
        ) : (
          <ul>
            {slots.map((slot) => (
              <li key={slot.start_at_utc}>
                <label>
                  <input
                    type="radio"
                    name="slot"
                    checked={selectedSlot?.start_at_utc === slot.start_at_utc}
                    onChange={() => setSelectedSlot(slot)}
                  />
                  {new Date(slot.start_at_utc).toLocaleString()}
                </label>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>Customer details</h2>
        <div>
          <label>
            Email
            <input value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
        </div>
        <div>
          <label>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
        </div>
        <div>
          <label>
            Company
            <input value={company} onChange={(e) => setCompany(e.target.value)} />
          </label>
        </div>
        <button type="button" onClick={createHold} disabled={!holdPayload || !email}>
          Create hold
        </button>
      </section>

      <section>
        <h2>Verify email</h2>
        <button type="button" onClick={sendVerification} disabled={!hold}>
          Send verification email
        </button>
        {verifyToken ? (
          <p>
            Verify link: {" "}
            <a href={`/verify?token=${encodeURIComponent(verifyToken)}&tenant=${encodeURIComponent(params.tenantSlug)}`}>
              /verify?token=...&tenant=...
            </a>
          </p>
        ) : null}
      </section>

      {status ? <p>Status: {status}</p> : null}
    </main>
  );
}
