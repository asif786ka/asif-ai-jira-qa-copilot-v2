"use client";

import { useState } from "react";
import type { TestCase } from "@jiraqa/core";
import { ChevronDown, ChevronUp, CheckCircle2, Circle } from "lucide-react";

const PRIORITY_STYLE: Record<string, string> = {
  critical: "border-red-500/40 text-red-300 bg-red-500/10",
  high: "border-orange-500/40 text-orange-300 bg-orange-500/10",
  medium: "border-emerald-500/40 text-emerald-300 bg-emerald-500/10",
  low: "border-gray-500/40 text-gray-300 bg-gray-500/10",
};

export function TestCaseCard({ tc, index }: { tc: TestCase; index: number }) {
  const [open, setOpen] = useState(false);
  const priorityClass = PRIORITY_STYLE[tc.priority ?? "medium"] ?? PRIORITY_STYLE.medium;

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
        <button
          onClick={() => setOpen((o) => !o)}
          className="text-gray-400 hover:text-white"
          aria-label={open ? "Collapse" : "Expand"}
        >
          {open ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
      </header>

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
