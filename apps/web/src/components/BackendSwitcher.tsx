"use client";

import { useEffect, useState } from "react";
import { Server, Zap } from "lucide-react";

type Backend = "typescript" | "python";

const STORAGE_KEY = "preferred-backend";

const BACKENDS: Record<Backend, { label: string; tech: string; gradient: string }> = {
  typescript: { label: "TypeScript", tech: "Next.js + Zod", gradient: "from-blue-400 to-cyan-300" },
  python: { label: "Python", tech: "FastAPI + Pydantic", gradient: "from-yellow-300 to-orange-300" },
};

export function BackendSwitcher() {
  const [active, setActive] = useState<Backend>("typescript");

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === "typescript" || stored === "python") {
        setActive(stored);
        fetch("/api/connections/save", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ preferred_backend: stored }),
        }).catch(() => {});
      }
    } catch {}
  }, []);

  const toggle = () => {
    const next: Backend = active === "typescript" ? "python" : "typescript";
    setActive(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {}
    fetch("/api/connections/save", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ preferred_backend: next }),
    }).catch(() => {});
    // Notify the generator page so it can flip its endpoint.
    window.dispatchEvent(new CustomEvent("backend-change", { detail: next }));
  };

  const cur = BACKENDS[active];

  return (
    <button
      onClick={toggle}
      title={`Backend: ${cur.label} / ${cur.tech} (click to swap)`}
      className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-border bg-bg-panel hover:bg-white/5 text-xs"
    >
      {active === "typescript" ? <Server className="w-3.5 h-3.5" /> : <Zap className="w-3.5 h-3.5" />}
      <span className={`bg-gradient-to-r ${cur.gradient} bg-clip-text text-transparent font-semibold`}>
        {cur.label}
      </span>
      <span className="hidden md:inline text-[10px] text-gray-500">{cur.tech}</span>
    </button>
  );
}

export function getActiveBackend(): Backend {
  if (typeof window === "undefined") return "typescript";
  try {
    const s = localStorage.getItem(STORAGE_KEY);
    if (s === "typescript" || s === "python") return s;
  } catch {}
  return "typescript";
}
