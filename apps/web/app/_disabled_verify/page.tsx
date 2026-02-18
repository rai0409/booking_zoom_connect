"use client";

import { useSearchParams } from "next/navigation";
import { useState } from "react";

export default function VerifyPage() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token") || "";
  const tenant = searchParams.get("tenant") || "";
  const apiBase = process.env.NEXT_PUBLIC_API_BASE || "http://localhost:4000";
  const [status, setStatus] = useState<string | null>(null);

  async function confirm() {
    if (!token || !tenant) {
      setStatus("Missing token or tenant");
      return;
    }

    setStatus("Confirming...");
    const res = await fetch(`${apiBase}/v1/public/${tenant}/confirm`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID()
      },
      body: JSON.stringify({ token })
    });

    setStatus(res.ok ? "Booking confirmed" : "Failed to confirm");
  }

  return (
    <main style={{ padding: 24, fontFamily: "ui-sans-serif, system-ui" }}>
      <h1>Verify booking</h1>
      <p>Token present: {token ? "yes" : "no"}</p>
      <p>Tenant: {tenant || "(missing)"}</p>
      <button type="button" onClick={confirm} disabled={!token || !tenant}>
        Confirm booking
      </button>
      {status ? <p>Status: {status}</p> : null}
    </main>
  );
}
