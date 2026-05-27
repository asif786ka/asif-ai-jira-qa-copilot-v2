"use client";

import { useState } from "react";
import type { PerCaseFlag, TestCase } from "@jiraqa/core";
import {
  ChevronDown,
  ChevronUp,
  CheckCircle2,
  Circle,
  ThumbsUp,
  ThumbsDown,
  AlertTriangle,
} from "lucide-react";

const PRIORITY_STYLE: Record<string, string> = {
  critical: "border-red-500/40 text-red-300 bg-red-500/10",
  high: "border-orange-500/40 text-orange-300 bg-orange-500/10",
  medium: "border-emerald-500/40 text-emerald-300 bg-emerald-500/10",
  low: "border-gray-500/40 text-gray-300 bg-gray-500/10",
};

type Props = {
  tc: TestCase;
  index: number;
  // Layer 4 — feedback metadata. The parent passes the ticket id and provider
  // so the feedback log can group by them later. `judgeFlag` is the matching
  // per_case_flag from the LLM-as-judge verdict, if any.
  ticketId?: string;
  provider?: string;
  judgeFlag?: PerCaseFlag;
};

export function TestCaseCard({ tc, index, ticketId, provider, judgeFlag }: Props) {
  const [open, setOpen] = useState(false);
  // Local rating state — once the user clicks, persist via /api/feedback.
  // We don't refetch; the optimistic update is enough for in-session UX.
  const [rating, setRating] = useState<"up" | "down" | null>(null);
  const [posting, setPosting] = useState(false);
  const priorityClass = PRIORITY_STYLE[tc.priority ?? "medium"] ?? PRIORITY_STYLE.medium;

  async function rate(value: "up" | "down") {
    if (posting) return;
    setPosting(true);
    // Optimistic: flip immediately. Roll back only on a hard server error.
    const previous = rating;
    setRating(value);
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ticket_id: ticketId ?? "unknown",
          test_case_id: tc.test_case_id,
          rating: value,
          provider,
          platform: tc.platform,
        }),
      });
      if (!res.ok) throw new Error(String(res.status));
    } catch {
      setRating(previous);
    } finally {
      setPosting(false);
    }
  }

  return (
    <article
      className="card animate-slide-up"
      style={{ animationDelay: `${index * 60}ms` }}
    >
      <header className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="pill">{tc.test_case_id}</span>
            <span className={`pill ${priorityClass}`}>{tc.priority ?? "medium"}</span>
            <span className="pill">{tc.platform}</span>
            {tc.automation_candidate ? (
              <span className="pill text-emerald-300 border-emerald-500/40 bg-emerald-500/10">
                <CheckCircle2 className="w-3 h-3" /> auto
              </span>
            ) : (
              <span className="pill text-gray-400">
                <Circle className="w-3 h-3" /> manual
              </span>
            )}
            {tc.automation_framework_hint && (
              <span className="pill text-cyan-300 border-cyan-500/30 bg-cyan-500/10">
                {tc.automation_framework_hint}
              </span>
            )}
          </div>
          <h3 className="mt-2 text-sm font-medium">{tc.test_scenario}</h3>
        </div>
        <div className="flex items-center gap-1">
          {/* Layer 4 — thumbs feedback. Persists to /api/feedback.
              We render unlabelled icon buttons to keep the header compact;
              the title attribute provides hover + assistive context. */}
          <button
            onClick={() => rate("up")}
            disabled={posting}
            title="Useful test case"
            aria-pressed={rating === "up"}
            aria-label="Mark useful"
            className={`p-1 rounded transition ${
              rating === "up"
                ? "text-emerald-300 bg-emerald-500/15"
                : "text-gray-500 hover:text-emerald-300 hover:bg-white/5"
            }`}
          >
            <ThumbsUp className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => rate("down")}
            disabled={posting}
            title="Weak / wrong test case"
            aria-pressed={rating === "down"}
            aria-label="Mark not useful"
            className={`p-1 rounded transition ${
              rating === "down"
                ? "text-red-300 bg-red-500/15"
                : "text-gray-500 hover:text-red-300 hover:bg-white/5"
            }`}
          >
            <ThumbsDown className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => setOpen((o) => !o)}
            className="text-gray-400 hover:text-white ml-1"
            aria-label={open ? "Collapse" : "Expand"}
          >
            {open ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
        </div>
      </header>

      {/* Layer 2 — judge per-case flag, when the LLM-as-judge marked this
          specific case as weak / hallucinated / redundant. Surfaces a hint. */}
      {judgeFlag && (
        <div className="mt-2 rounded-lg border border-amber-700/40 bg-amber-900/10 px-2.5 py-1.5 text-[11px] text-amber-200 flex items-start gap-2">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
          <div className="space-y-0.5">
            <div>
              <span className="font-mono opacity-70">{judgeFlag.code}:</span>{" "}
              {judgeFlag.message}
            </div>
            {judgeFlag.hint && (
              <div className="opacity-70">Hint: {judgeFlag.hint}</div>
            )}
          </div>
        </div>
      )}

      <div className="mt-3 text-xs text-gray-400">
        <span className="text-gray-500">Expected:</span> {tc.expected_result}
      </div>

      {open && (
        <div className="mt-4 space-y-3 text-xs">
          <Section title="Preconditions" items={tc.preconditions} />
          <Section title="Steps" items={tc.test_steps} ordered />
          <Section title="Test data" items={tc.test_data} />
          {tc.tags?.length > 0 && (
            <div>
              <div className="text-gray-500 mb-1">Tags</div>
              <div className="flex flex-wrap gap-1">
                {tc.tags.map((t) => (
                  <span key={t} className="pill">
                    #{t}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </article>
  );
}

function Section({
  title,
  items,
  ordered = false,
}: {
  title: string;
  items: string[];
  ordered?: boolean;
}) {
  if (!items?.length) return null;
  const ListTag = (ordered ? "ol" : "ul") as "ol" | "ul";
  return (
    <div>
      <div className="text-gray-500 mb-1">{title}</div>
      <ListTag
        className={`${ordered ? "list-decimal" : "list-disc"} ml-4 space-y-1 text-gray-300`}
      >
        {items.map((it, i) => (
          <li key={i}>{it}</li>
        ))}
      </ListTag>
    </div>
  );
}
