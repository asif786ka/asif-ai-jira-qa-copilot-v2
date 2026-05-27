"use client";

/**
 * QualityBadge
 *
 * Renders the LLM-as-judge verdict that the /generate endpoint returns as
 * the optional `quality` field. Shows:
 *   - A score chip colored by the standard QA thresholds (≥85 green,
 *     70-84 yellow, <70 red).
 *   - The judge's one-line summary, when present.
 *   - The judge provider (so users know which LLM scored which).
 *
 * Per-case flags are surfaced separately on each TestCaseCard so the
 * reviewer sees criticism in-context.
 */

import { Award } from "lucide-react";
import type { QualityScore } from "@jiraqa/core";

type Props = { quality: QualityScore | null | undefined };

export function QualityBadge({ quality }: Props) {
  if (!quality || quality.score === null || quality.score === undefined) {
    return null;
  }
  const s = quality.score;
  // Stay readable in dark mode: ring + tinted bg, not a saturated fill.
  const tone =
    s >= 85
      ? "border-green-600/50 bg-green-900/15 text-green-200"
      : s >= 70
        ? "border-yellow-600/50 bg-yellow-900/15 text-yellow-200"
        : "border-red-600/50 bg-red-900/15 text-red-200";
  return (
    <div
      className={`rounded-lg border px-3 py-2 text-xs flex items-start gap-2 ${tone}`}
    >
      <Award className="w-4 h-4 mt-0.5 flex-shrink-0" />
      <div className="space-y-0.5 flex-1 min-w-0">
        <div className="font-semibold">
          Quality score: <span className="font-mono">{s}/100</span>
          {quality.judge_provider && (
            <span className="ml-2 text-[10px] opacity-70 font-normal">
              judged by {quality.judge_provider}
            </span>
          )}
        </div>
        {quality.summary && <div className="opacity-80">{quality.summary}</div>}
      </div>
    </div>
  );
}
