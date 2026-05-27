"use client";

/**
 * TicketValidationPanel
 *
 * Renders the result of a ticket-readiness validation run (from either
 * /api/validate-ticket or the 422 envelope from /api/generate).
 *
 * Used by both the Jira-driven flow (Wizard.tsx) and the Custom Scenario
 * form so the rejection UX is identical regardless of how the ticket got
 * into the app.
 *
 * States:
 *   - loading: muted "Checking ticket…" row, shown while a request is in flight.
 *   - passed: green badge with the optional rubric summary.
 *   - failed: red panel listing every issue with field, message, hint.
 *
 * The panel is purely presentational — the parent owns the result state and
 * also owns the Generate button (it should disable Generate when !passed).
 */

import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react";
import type { TicketValidationResult } from "@jiraqa/core";

type Props = {
  result: TicketValidationResult | null;
  loading?: boolean;
  /** Display name for the field — falls back to a friendly version of the key. */
  fieldLabels?: Record<string, string>;
};

const DEFAULT_FIELD_LABELS: Record<string, string> = {
  summary: "Summary",
  description: "Description",
  acceptance_criteria: "Acceptance criteria",
  ticket: "Ticket",
};

export function TicketValidationPanel({ result, loading, fieldLabels }: Props) {
  if (loading) {
    return (
      <div className="rounded-lg border border-border bg-bg-panel px-3 py-2 text-xs text-gray-400 flex items-center gap-2">
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        Checking ticket against QA-readiness rules…
      </div>
    );
  }

  if (!result) return null;

  if (result.passed) {
    return (
      <div className="rounded-lg border border-green-700/40 bg-green-900/10 px-3 py-2 text-xs text-green-300 flex items-start gap-2">
        <CheckCircle2 className="w-4 h-4 flex-shrink-0 mt-0.5" />
        <div className="space-y-0.5">
          <div className="font-medium">Ticket passes QA-readiness checks.</div>
          {result.rubric_summary && (
            <div className="text-green-400/80">
              {result.rubric_score !== null && result.rubric_score !== undefined && (
                <span className="font-mono mr-1">[{result.rubric_score}/100]</span>
              )}
              {result.rubric_summary}
            </div>
          )}
        </div>
      </div>
    );
  }

  // Failed — group by field so the QA team sees one panel per problem area.
  const labels = { ...DEFAULT_FIELD_LABELS, ...(fieldLabels ?? {}) };
  const grouped: Record<string, typeof result.issues> = {};
  for (const issue of result.issues) {
    const key = issue.field || "ticket";
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(issue);
  }

  return (
    <div className="rounded-lg border border-red-700/50 bg-red-900/10 px-3 py-3 text-xs space-y-2">
      <div className="flex items-center gap-2 text-red-300 font-medium">
        <AlertCircle className="w-4 h-4" />
        Ticket is not ready for test generation
        {result.rubric_score !== null && result.rubric_score !== undefined && (
          <span className="ml-auto font-mono text-[10px] text-red-400/80">
            rubric {result.rubric_score}/100
          </span>
        )}
      </div>
      {result.rubric_summary && (
        <div className="text-red-200/80 italic pl-6">{result.rubric_summary}</div>
      )}
      <ul className="space-y-2 pl-6 list-disc marker:text-red-500">
        {Object.entries(grouped).map(([field, issues]) => (
          <li key={field}>
            <div className="text-red-200 font-medium">
              {labels[field] ?? field}
            </div>
            <ul className="mt-1 space-y-1.5 pl-2 list-none">
              {issues.map((iss, i) => (
                <li key={`${iss.code}-${i}`} className="text-red-100/90">
                  <div>{iss.message}</div>
                  {iss.hint && (
                    <div className="text-red-300/70 text-[11px] mt-0.5">
                      Hint: {iss.hint}
                    </div>
                  )}
                  <div className="text-red-400/40 font-mono text-[10px] mt-0.5">
                    {iss.code}
                  </div>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      <div className="text-red-300/70 pl-6 pt-1">
        Fix the ticket (in Jira or in the form above) and re-check.
      </div>
    </div>
  );
}
