/**
 * @module @jiraqa/core/dora
 *
 * DORA metrics — types, tier classification, and computation helpers.
 * Based on the DORA team's 2023 State of DevOps Report thresholds.
 *
 * The 4 metrics:
 *   • Deployment Frequency — merges to main / week (proxy for deploys)
 *   • Lead Time for Changes — first commit on a PR → merged_at
 *   • Change Failure Rate — % of deploys followed by a bug/incident within N days
 *   • MTTR — time from incident-bug created → resolved
 */

import { z } from "zod";

export const DoraTier = z.enum(["elite", "high", "medium", "low", "unknown"]);
export type DoraTier = z.infer<typeof DoraTier>;

export const DoraMetricSchema = z.object({
  value: z.number().nullable(),
  unit: z.string(),
  tier: DoraTier,
  /** Human-readable explanation (e.g. "12 deploys/week (Elite >1/day)"). */
  description: z.string(),
});
export type DoraMetric = z.infer<typeof DoraMetricSchema>;

export const DoraResponseSchema = z.object({
  window_days: z.number(),
  source: z.object({
    main_repo: z.string(),
    main_head_sha: z.string().optional(),
    jira_project: z.string().optional(),
  }),
  deployment_frequency: DoraMetricSchema,
  lead_time_hours: DoraMetricSchema,
  change_failure_rate: DoraMetricSchema,
  mttr_hours: DoraMetricSchema,
  /** Raw sample sizes so users can judge confidence. */
  sample: z.object({
    merged_prs: z.number(),
    incidents: z.number(),
    resolved_incidents: z.number(),
  }),
  /** Optional AI-generated bottleneck insight. */
  insight: z.string().optional(),
});
export type DoraResponse = z.infer<typeof DoraResponseSchema>;

// ────────────────────────────────────────────────────────────────────────────
// Tier classification — Google DORA report 2023/2024 benchmarks
// ────────────────────────────────────────────────────────────────────────────

export function classifyDeploymentFrequency(perWeek: number): DoraTier {
  if (perWeek >= 7) return "elite"; // ≥1 / day
  if (perWeek >= 1) return "high"; // 1/week → 1/day
  if (perWeek >= 0.25) return "medium"; // 1/month → 1/week
  return "low";
}

export function classifyLeadTime(hours: number): DoraTier {
  if (hours < 24) return "elite"; // <1 day
  if (hours < 24 * 7) return "high"; // <1 week
  if (hours < 24 * 30) return "medium"; // <1 month
  return "low";
}

export function classifyChangeFailureRate(pct: number): DoraTier {
  // DORA 2023: Elite and High both 0–15%
  if (pct <= 0.15) return "high";
  if (pct <= 0.3) return "medium";
  return "low";
}

export function classifyMTTR(hours: number): DoraTier {
  if (hours < 1) return "elite";
  if (hours < 24) return "high";
  if (hours < 24 * 7) return "medium";
  return "low";
}

// ────────────────────────────────────────────────────────────────────────────
// Formatting
// ────────────────────────────────────────────────────────────────────────────

export function formatHours(hours: number): string {
  if (hours < 1) return `${(hours * 60).toFixed(0)} min`;
  if (hours < 24) return `${hours.toFixed(1)} hr`;
  const days = hours / 24;
  if (days < 7) return `${days.toFixed(1)} days`;
  if (days < 30) return `${(days / 7).toFixed(1)} weeks`;
  return `${(days / 30).toFixed(1)} months`;
}

export function formatPerWeek(n: number): string {
  if (n >= 7) return `${(n / 7).toFixed(1)} / day`;
  if (n >= 1) return `${n.toFixed(1)} / week`;
  if (n >= 0.25) return `${(n * 4.33).toFixed(1)} / month`;
  return `${n.toFixed(2)} / week`;
}
