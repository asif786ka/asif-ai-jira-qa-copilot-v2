"use client";

import Link from "next/link";
import { Sparkles } from "lucide-react";
import { ProviderSwitcher } from "./ProviderSwitcher";
import { BackendSwitcher } from "./BackendSwitcher";

export function Header() {
  return (
    <header className="sticky top-0 z-50 backdrop-blur bg-black/30 border-b border-border">
      <div className="mx-auto max-w-7xl px-4 py-3 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-2 group">
          <span className="w-8 h-8 rounded-lg bg-gradient-to-br from-accent to-accent-glow flex items-center justify-center">
            <Sparkles className="w-4 h-4 text-black" />
          </span>
          <div>
            <div className="text-sm font-semibold tracking-wide">JIRAQA</div>
            <div className="text-[10px] text-gray-500 -mt-0.5">
              AI-generated test cases · v2
            </div>
          </div>
        </Link>
        <nav className="flex items-center gap-2">
          <Link
            href="/connections"
            className="text-xs px-3 py-1.5 rounded-lg border border-border bg-bg-panel hover:bg-white/5"
          >
            Connections
          </Link>
          <Link
            href="/"
            className="text-xs px-3 py-1.5 rounded-lg border border-border bg-bg-panel hover:bg-white/5"
          >
            Generator
          </Link>
          <ProviderSwitcher />
          <BackendSwitcher />
        </nav>
      </div>
    </header>
  );
}
