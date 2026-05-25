"use client";

import { useEffect, useState } from "react";
import { Cpu } from "lucide-react";

type Provider = "openai" | "gemini";

const STORAGE_KEY = "preferred-llm-provider";

const PROVIDERS: Record<Provider, { label: string; gradient: string }> = {
  openai: { label: "OpenAI", gradient: "from-emerald-400 to-teal-300" },
  gemini: { label: "Gemini", gradient: "from-sky-400 to-violet-400" },
};

export function ProviderSwitcher() {
  const [active, setActive] = useState<Provider>("openai");

  // On mount: read localStorage AND push it to the server cookie so the
  // backend honours the UI selection even on first request of a session.
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === "openai" || stored === "gemini") {
        setActive(stored);
        fetch("/api/connections/save", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ preferred_provider: stored }),
        }).catch(() => {});
      }
    } catch {}
  }, []);

  const toggle = async () => {
    const next: Provider = active === "openai" ? "gemini" : "openai";
    setActive(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {}
    // Persist on the server too so /api/generate picks it up by default.
    fetch("/api/connections/save", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ preferred_provider: next }),
    }).catch(() => {});
  };

  const cur = PROVIDERS[active];

  return (
    <button
      onClick={toggle}
      title={`LLM provider: ${cur.label} (click to swap)`}
      className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-border bg-bg-panel hover:bg-white/5 text-xs"
    >
      <Cpu className="w-3.5 h-3.5" />
      <span
        className={`bg-gradient-to-r ${cur.gradient} bg-clip-text text-transparent font-semibold`}
      >
        {cur.label}
      </span>
    </button>
  );
}
