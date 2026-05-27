/**
 * @module @jiraqa/core/validation
 *
 * Ticket-readiness validator — TypeScript mirror of apps/api-python/api/validation.py.
 *
 * Keep this file in lockstep with the Python version. Both backends MUST
 * produce the same `issues` list for the same ticket; the rubric pass is
 * the only place behaviour legitimately diverges (different LLMs).
 *
 * The deterministic rules live here so:
 *   - The TS /api/generate route can gate without crossing to the Python sidecar.
 *   - The UI can do an instant client-side preview (no round-trip) if it wants.
 *   - The standalone /api/validate-ticket route can serve TS-backend users.
 */

import { z } from "zod";
import { JiraTicketSchema, PlatformSchema } from "./types";
import type { JiraTicket, Platform } from "./types";

// ────────────────────────────────────────────────────────────────────────────
// Tunables — keep in sync with apps/api-python/api/validation.py
// ────────────────────────────────────────────────────────────────────────────

export const MIN_SUMMARY_LEN = 10;
export const MIN_DESCRIPTION_LEN = 30;
export const MIN_ACCEPTANCE_CRITERIA = 2;
export const MIN_ACCEPTANCE_CRITERION_LEN = 5;
export const RUBRIC_PASS_THRESHOLD = 70;

const PLACEHOLDER_TOKENS = [
  "tbd",
  "todo",
  "tba",
  "n/a",
  "fill in later",
  "fill this in",
  "to be determined",
  "to be added",
] as const;
// \b word boundaries — won't match inside longer words.
const PLACEHOLDER_RE = new RegExp(
  `\\b(${PLACEHOLDER_TOKENS.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`,
  "i",
);

const REPRO_RE = /\b(steps? to reproduce|reproduce|reproduction|how to reproduce|repro steps?)\b/i;
const EXPECTED_RE = /\b(expected|should|must)\b/i;
const ACTUAL_RE = /\b(actual|got|but instead|currently|observed|happens)\b/i;
const SUMMARY_JUNK_RE = /^(?:tbd|todo|test|asdf|xxx+|placeholder)$/i;

// ────────────────────────────────────────────────────────────────────────────
// Zod schemas — wire shape for /api/validate-ticket
// ────────────────────────────────────────────────────────────────────────────

export const TicketValidationIssueSchema = z.object({
  field: z.string(), // "summary" | "description" | "acceptance_criteria" | "ticket"
  code: z.string(),
  severity: z.string().default("error"),
  message: z.string(),
  hint: z.string().optional().nullable(),
});
export type TicketValidationIssue = z.infer<typeof TicketValidationIssueSchema>;

export const TicketValidationResultSchema = z.object({
  passed: z.boolean(),
  issues: z.array(TicketValidationIssueSchema).default([]),
  rubric_score: z.number().int().nullable().optional(),
  rubric_summary: z.string().nullable().optional(),
});
export type TicketValidationResult = z.infer<typeof TicketValidationResultSchema>;

export const ValidateTicketRequestSchema = z.object({
  ticket: JiraTicketSchema,
  platform: PlatformSchema,
  use_llm_rubric: z.boolean().optional().default(true),
  provider: z.enum(["openai", "gemini", "anthropic"]).optional(),
});
export type ValidateTicketRequest = z.infer<typeof ValidateTicketRequestSchema>;

// ────────────────────────────────────────────────────────────────────────────
// Rules
// ────────────────────────────────────────────────────────────────────────────

function ruleSummary(ticket: JiraTicket): TicketValidationIssue[] {
  const issues: TicketValidationIssue[] = [];
  const s = (ticket.summary ?? "").trim();
  if (!s) {
    issues.push({
      field: "summary",
      code: "summary_missing",
      severity: "error",
      message: "Summary is required.",
      hint: "Add a one-line description of the change, e.g. 'Login screen rejects empty password with inline error'.",
    });
    return issues;
  }
  if (s.length < MIN_SUMMARY_LEN) {
    issues.push({
      field: "summary",
      code: "summary_too_short",
      severity: "error",
      message: `Summary must be at least ${MIN_SUMMARY_LEN} characters (got ${s.length}).`,
      hint: "Describe what changes and where, not just 'fix' or 'bug'.",
    });
  }
  if (SUMMARY_JUNK_RE.test(s)) {
    issues.push({
      field: "summary",
      code: "summary_placeholder",
      severity: "error",
      message: `Summary '${s}' looks like a placeholder.`,
      hint: "Replace with a real one-line description of the change.",
    });
  }
  return issues;
}

function ruleDescription(ticket: JiraTicket): TicketValidationIssue[] {
  const issues: TicketValidationIssue[] = [];
  const d = (ticket.description ?? "").trim();
  if (!d) {
    issues.push({
      field: "description",
      code: "description_missing",
      severity: "error",
      message: "Description is required.",
      hint: "Explain the desired behaviour, screen/component, and any constraints.",
    });
    return issues;
  }
  if (d.length < MIN_DESCRIPTION_LEN) {
    issues.push({
      field: "description",
      code: "description_too_short",
      severity: "error",
      message: `Description must be at least ${MIN_DESCRIPTION_LEN} characters (got ${d.length}).`,
      hint: "Add context: what changes, where, why, and any edge cases to consider.",
    });
  }
  const m = d.match(PLACEHOLDER_RE);
  if (m) {
    issues.push({
      field: "description",
      code: "description_placeholder",
      severity: "error",
      message: `Description contains placeholder text ('${m[1]}'). Replace it with the actual behaviour.`,
      hint: "What should happen? Where? Under what conditions?",
    });
  }
  return issues;
}

function ruleAcceptanceCriteria(ticket: JiraTicket): TicketValidationIssue[] {
  const issues: TicketValidationIssue[] = [];
  const acs = (ticket.acceptance_criteria ?? [])
    .map((a) => (a ?? "").trim())
    .filter((a) => a.length > 0);
  if (acs.length < MIN_ACCEPTANCE_CRITERIA) {
    issues.push({
      field: "acceptance_criteria",
      code: "ac_too_few",
      severity: "error",
      message: `Need at least ${MIN_ACCEPTANCE_CRITERIA} acceptance criteria (got ${acs.length}).`,
      hint: "Add at least a happy-path case and a negative / edge case.",
    });
  }
  const short = acs.filter((a) => a.length < MIN_ACCEPTANCE_CRITERION_LEN);
  if (short.length > 0) {
    issues.push({
      field: "acceptance_criteria",
      code: "ac_too_short",
      severity: "error",
      message: `${short.length} acceptance criteria are too short to be testable.`,
      hint: "Use Given/When/Then phrasing with concrete inputs and outputs.",
    });
  }
  return issues;
}

function ruleBugSpecifics(ticket: JiraTicket): TicketValidationIssue[] {
  if (ticket.issue_type !== "bug") return [];
  const issues: TicketValidationIssue[] = [];
  const d = ticket.description ?? "";
  if (!REPRO_RE.test(d)) {
    issues.push({
      field: "description",
      code: "bug_missing_repro",
      severity: "error",
      message: "Bug tickets must include steps to reproduce.",
      hint: "Add a 'Steps to reproduce:' section with numbered steps.",
    });
  }
  if (!(EXPECTED_RE.test(d) && ACTUAL_RE.test(d))) {
    issues.push({
      field: "description",
      code: "bug_missing_expected_vs_actual",
      severity: "error",
      message: "Bug tickets must describe expected vs actual behaviour.",
      hint: "Add 'Expected: ...' and 'Actual: ...' lines.",
    });
  }
  return issues;
}

/**
 * Run every deterministic rule and aggregate issues. Used by both /api/generate
 * (as a gate) and /api/validate-ticket (as the first phase).
 */
export function runDeterministicRules(ticket: JiraTicket): TicketValidationIssue[] {
  return [
    ...ruleSummary(ticket),
    ...ruleDescription(ticket),
    ...ruleAcceptanceCriteria(ticket),
    ...ruleBugSpecifics(ticket),
  ];
}

/**
 * Convenience wrapper that returns a full TicketValidationResult. The LLM
 * rubric pass is NOT performed here — the rubric lives in the route handler
 * so it can use the right provider abstraction. Phase-1 only.
 */
export function validateTicketRulesOnly(ticket: JiraTicket): TicketValidationResult {
  const issues = runDeterministicRules(ticket);
  return { passed: issues.length === 0, issues };
}

// ────────────────────────────────────────────────────────────────────────────
// Rubric prompts — TS mirror of prompt.build_rubric_*_prompt in Python.
// ────────────────────────────────────────────────────────────────────────────

export function buildRubricSystemPrompt(): string {
  return `You are a senior QA reviewer. Your job is to decide whether a Jira ticket
is TESTABLE — i.e. whether a QA engineer could write a step-by-step test case
from it without guessing.

Score the ticket on a 0-100 scale across these dimensions:
  1. Clarity of expected behaviour — Are post-conditions measurable, or vague
     ("snappier", "more reliable", "better UX")?
  2. Acceptance criteria quality — Are they Given/When/Then-style with concrete
     inputs and outputs, or do they restate the summary?
  3. Preconditions / environment — Is the starting state specified well enough
     to reproduce the scenario?
  4. Edge / negative coverage — Does the ticket hint at boundaries, errors,
     empty states, or only the happy path?

Threshold: score >= ${RUBRIC_PASS_THRESHOLD} ⇒ passed=true. Score < ${RUBRIC_PASS_THRESHOLD} ⇒ passed=false and you MUST
populate \`issues\` explaining what to fix.

OUTPUT
Return ONLY a JSON object matching exactly this shape, no prose, no fences:
{
  "score": <integer 0-100>,
  "passed": <boolean>,
  "summary": "<one-sentence verdict>",
  "issues": [
    {
      "field": "summary" | "description" | "acceptance_criteria" | "ticket",
      "code": "<snake_case identifier, e.g. ambiguous_expected_behavior>",
      "severity": "error",
      "message": "<what's wrong in plain English>",
      "hint": "<concrete suggestion for how to fix it>"
    }
  ]
}
If passed=true, \`issues\` MUST be an empty list.`;
}

export function buildRubricUserPrompt(ticket: JiraTicket, platform: Platform): string {
  const lines: string[] = [];
  lines.push("# JIRA TICKET TO REVIEW");
  lines.push(`Ticket ID: ${ticket.ticket_id}`);
  lines.push(`Summary: ${ticket.summary}`);
  lines.push(`Issue Type: ${ticket.issue_type}`);
  lines.push(`Priority: ${ticket.priority}`);
  if (ticket.component) lines.push(`Component: ${ticket.component}`);
  if (ticket.environment) lines.push(`Environment: ${ticket.environment}`);
  if (ticket.labels && ticket.labels.length > 0) {
    lines.push(`Labels: ${ticket.labels.join(", ")}`);
  }
  lines.push("");
  lines.push("Description:");
  lines.push(ticket.description || "(empty)");
  lines.push("");
  lines.push("Acceptance Criteria:");
  if (ticket.acceptance_criteria && ticket.acceptance_criteria.length > 0) {
    ticket.acceptance_criteria.forEach((ac, i) => lines.push(`  ${i + 1}. ${ac}`));
  } else {
    lines.push("  (none)");
  }
  lines.push("");
  lines.push(`Target platform: ${platform}`);
  lines.push("");
  lines.push("Return ONLY the JSON object as specified in the system prompt.");
  return lines.join("\n");
}
