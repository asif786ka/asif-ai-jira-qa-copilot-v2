/**
 * @module @jiraqa/core/judge
 *
 * TypeScript mirror of apps/api-python/api/judge.py — prompt builders and
 * result types. The actual LLM call lives in the route handler (it owns the
 * provider abstraction), but the prompts and types live here so both
 * backends speak the same shape.
 */

import { z } from "zod";
import type { JiraTicket, Platform, TestCase } from "./types";

// ────────────────────────────────────────────────────────────────────────────
// Result schema — surfaced as `quality` on GenerateResponse payload
// ────────────────────────────────────────────────────────────────────────────

export const PerCaseFlagSchema = z.object({
  test_case_id: z.string(),
  code: z.string(),
  message: z.string(),
  hint: z.string().optional().nullable(),
});
export type PerCaseFlag = z.infer<typeof PerCaseFlagSchema>;

export const QualityScoreSchema = z.object({
  score: z.number().int().nullable().optional(),
  summary: z.string().nullable().optional(),
  judge_provider: z.string().nullable().optional(),
  per_case_flags: z.array(PerCaseFlagSchema).default([]),
});
export type QualityScore = z.infer<typeof QualityScoreSchema>;

// ────────────────────────────────────────────────────────────────────────────
// Prompts — keep in lockstep with apps/api-python/api/prompt.py
// ────────────────────────────────────────────────────────────────────────────

export function buildJudgeSystemPrompt(): string {
  return `You are a senior QA reviewer. You are given a Jira ticket and a batch of
test cases generated from it. Your job is to score the BATCH on a 0-100 scale
and flag any individual test cases that are weak or hallucinated.

Score across four dimensions (equal weight):
  1. COVERAGE — Does the batch cover positive, negative, and edge cases for
     the behaviour the ticket describes? Are there obvious scenarios missing?
  2. ATOMICITY — Is each test step exactly one user action, or are some
     compound ("tap X and verify Y")?
  3. MEASURABILITY — Is each expected_result specific and verifiable, or
     vague ("it works", "behaves correctly")?
  4. GROUNDEDNESS — Do test cases reference real UI elements / behaviour
     from the ticket, or did the LLM invent buttons / screens / data that
     the ticket doesn't mention?

OUTPUT
Return ONLY a JSON object matching exactly this shape, no prose, no fences:
{
  "score": <integer 0-100>,
  "summary": "<one-sentence overall verdict>",
  "per_case_flags": [
    {
      "test_case_id": "TC-002",
      "code": "<snake_case, e.g. hallucinated_ui_element | redundant | untestable>",
      "message": "<what's wrong with this specific case>",
      "hint": "<how to fix it>"
    }
  ]
}
Only include per_case_flags for cases that have real issues. An empty
per_case_flags list means every case is acceptable individually.`;
}

export function buildJudgeUserPrompt(
  ticket: JiraTicket,
  platform: Platform,
  cases: TestCase[],
): string {
  const lines: string[] = [];
  lines.push("# ORIGINAL TICKET");
  lines.push(`Ticket ID: ${ticket.ticket_id}`);
  lines.push(`Summary: ${ticket.summary}`);
  lines.push(`Platform: ${platform}`);
  if (ticket.description) lines.push(`Description: ${ticket.description}`);
  if (ticket.acceptance_criteria && ticket.acceptance_criteria.length > 0) {
    lines.push("Acceptance Criteria:");
    ticket.acceptance_criteria.forEach((ac, i) => lines.push(`  ${i + 1}. ${ac}`));
  }
  lines.push("");
  lines.push(`# GENERATED TEST CASES (${cases.length})`);
  // Cap the payload at ~8 KB to keep token usage predictable on big batches.
  const json = JSON.stringify(cases, null, 2);
  lines.push(json.length > 8000 ? json.slice(0, 8000) : json);
  lines.push("");
  lines.push("Return ONLY the JSON object as specified in the system prompt.");
  return lines.join("\n");
}

/**
 * Parse a judge response from raw JSON text. Returns a partial QualityScore
 * on any error — judge failures must never block.
 */
export function parseJudgeResponse(
  rawJson: string,
  judgeProviderName?: string,
): QualityScore {
  try {
    const parsed = JSON.parse(rawJson) as Record<string, unknown>;
    const scoreRaw = parsed.score;
    const score =
      typeof scoreRaw === "number" && Number.isFinite(scoreRaw)
        ? Math.round(scoreRaw)
        : null;
    const summary = typeof parsed.summary === "string" ? parsed.summary : null;
    const flagsRaw = Array.isArray(parsed.per_case_flags) ? parsed.per_case_flags : [];
    const flags: PerCaseFlag[] = flagsRaw
      .filter((it): it is Record<string, unknown> => !!it && typeof it === "object")
      .map((it) => ({
        test_case_id: typeof it.test_case_id === "string" ? it.test_case_id : "",
        code: typeof it.code === "string" ? it.code : "judge_flag",
        message: typeof it.message === "string" ? it.message : "",
        hint: typeof it.hint === "string" ? it.hint : undefined,
      }));
    return {
      score,
      summary,
      judge_provider: judgeProviderName ?? null,
      per_case_flags: flags,
    };
  } catch {
    return {
      score: null,
      summary: null,
      judge_provider: judgeProviderName ?? null,
      per_case_flags: [],
    };
  }
}
