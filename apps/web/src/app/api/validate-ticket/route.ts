/**
 * POST /api/validate-ticket
 *
 * Ticket-readiness gate for the QA team. Same job as the Python sidecar's
 * /pyapi/validate-ticket — runs the deterministic rules from @jiraqa/core,
 * then (when use_llm_rubric=true and a provider is available) asks the LLM
 * to score the ticket on testability.
 *
 * Always returns 200 — even when the ticket is rejected — because the
 * HTTP request itself was valid. Branch on `result.passed`.
 *
 * 4xx is reserved for actual request errors (bad shape, missing fields).
 */

import {
  ValidateTicketRequestSchema,
  buildRubricSystemPrompt,
  buildRubricUserPrompt,
  runDeterministicRules,
  RUBRIC_PASS_THRESHOLD,
  type TicketValidationIssue,
  type TicketValidationResult,
} from "@jiraqa/core";
import { resolveLLMProvider } from "@jiraqa/providers";
import { errorResponse, jsonResponse } from "@/lib/utils";
import { getSession } from "@/lib/session";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(req: Request) {
  const parsed = ValidateTicketRequestSchema.safeParse(
    await req.json().catch(() => null),
  );
  if (!parsed.success) {
    return errorResponse("Invalid request body", 400, parsed.error.message);
  }
  const { ticket, platform, use_llm_rubric, provider } = parsed.data;

  // Phase 1 — deterministic rules. Fail fast, no LLM call.
  const ruleIssues = runDeterministicRules(ticket);
  if (ruleIssues.length > 0) {
    const result: TicketValidationResult = { passed: false, issues: ruleIssues };
    return jsonResponse(result);
  }

  // Phase 2 — optional LLM rubric. If anything goes wrong (no provider, network
  // error, malformed JSON) we DON'T block — we return rules-only pass=true.
  // This matches the Python contract: rubric is enrichment, never a hard gate.
  if (!use_llm_rubric) {
    const result: TicketValidationResult = { passed: true, issues: [] };
    return jsonResponse(result);
  }

  const session = await getSession();
  const providerName = provider ?? session.preferred_provider;
  let llm;
  try {
    llm = resolveLLMProvider(providerName);
  } catch {
    // No provider configured — skip rubric silently.
    const result: TicketValidationResult = { passed: true, issues: [] };
    return jsonResponse(result);
  }

  let raw: string;
  try {
    const completion = await llm.complete({
      systemPrompt: buildRubricSystemPrompt(),
      userPrompt: buildRubricUserPrompt(ticket, platform),
      temperature: 0.1,
      jsonMode: true,
      maxTokens: 800,
    });
    raw = completion.text;
  } catch {
    const result: TicketValidationResult = { passed: true, issues: [] };
    return jsonResponse(result);
  }

  let rubric: unknown;
  try {
    rubric = JSON.parse(raw);
  } catch {
    // Bad JSON from the model — same fallback: don't block.
    const result: TicketValidationResult = { passed: true, issues: [] };
    return jsonResponse(result);
  }

  const r = rubric as {
    score?: unknown;
    summary?: unknown;
    issues?: unknown;
  };
  const score =
    typeof r.score === "number" && Number.isFinite(r.score) ? Math.round(r.score) : null;
  const summary = typeof r.summary === "string" ? r.summary : null;

  const issues: TicketValidationIssue[] = Array.isArray(r.issues)
    ? r.issues
        .filter((it): it is Record<string, unknown> => !!it && typeof it === "object")
        .map((it) => ({
          field: typeof it.field === "string" ? it.field : "ticket",
          code: typeof it.code === "string" ? it.code : "rubric_issue",
          severity: typeof it.severity === "string" ? it.severity : "error",
          message: typeof it.message === "string" ? it.message : "",
          hint: typeof it.hint === "string" ? it.hint : undefined,
        }))
    : [];

  // Trust the threshold, not the model's `passed` flag.
  let passed = true;
  if (score !== null && score < RUBRIC_PASS_THRESHOLD) passed = false;
  if (issues.length > 0) passed = false;

  // If score is low but the model didn't list any issues, synthesize one so
  // the user sees the verdict instead of a silent rejection.
  if (
    !passed &&
    issues.length === 0 &&
    score !== null &&
    score < RUBRIC_PASS_THRESHOLD
  ) {
    issues.push({
      field: "ticket",
      code: "rubric_low_score",
      severity: "error",
      message: summary ?? `Ticket scored ${score}/100 on the QA-readiness rubric.`,
      hint: "Tighten expected behaviour, add measurable thresholds, and include edge cases.",
    });
  }

  const result: TicketValidationResult = {
    passed,
    issues,
    rubric_score: score,
    rubric_summary: summary,
  };
  return jsonResponse(result);
}
