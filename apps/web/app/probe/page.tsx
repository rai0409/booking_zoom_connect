"use client";

import { useEffect, useState } from "react";

export default function ProbePage() {
  const [count, setCount] = useState(0);
  const [hydrated, setHydrated] = useState(false);
  const [href, setHref] = useState("");

  useEffect(() => {
    setHydrated(true);
    setHref(window.location.href);
  }, []);

  return (
    <div style={{ padding: 24 }}>
      <h1>probe</h1>
      <pre>
        {JSON.stringify(
          {
            count,
            hydrated,
            href
          },
          null,
          2
        )}
      </pre>
      <button onClick={() => setCount((v) => v + 1)}>count up</button>
    </div>
  );
}
