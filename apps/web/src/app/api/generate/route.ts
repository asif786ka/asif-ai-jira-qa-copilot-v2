/**
 * POST /api/generate
 * The headline endpoint. Pipeline:
 *   1. Zod-validate request
 *   2. Resolve LLM provider from session preference or explicit param
 *   3. Build platform-aware system + user prompts
 *   4. Call the LLM (JSON mode, low temperature)
 *   5. JSON-parse + Zod-validate the model's output
 *   6. Return GenerateResponse or structured error
 */

import {
  GenerateRequestSchema,
  GenerateResponseSchema,
  buildJudgeSystemPrompt,
  buildJudgeUserPrompt,
  buildSystemPrompt,
  buildUserPrompt,
  errorsOnly,
  lintGeneratedCases,
  parseJudgeResponse,
  runDeterministicRules,
  type QualityScore,
} from "@jiraqa/core";
import { resolveLLMProvider, resolveVisionProvider } from "@jiraqa/providers";
import { errorResponse, jsonResponse } from "@/lib/utils";
import { getSession } from "@/lib/session";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request) {
  // 1. Validate request
  const parsed = GenerateRequestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return errorResponse("Invalid request body", 400, parsed.error.message);
  }
  const { ticket, platform, repo_context, provider, count_hint, screenshots, judge } =
    parsed.data;

  // 1b. Gate on ticket quality. If the QA-readiness rules fail, short-circuit
  // with 422 BEFORE spending an LLM call. The semantic rubric pass is
  // intentionally NOT run here — that's what /api/validate-ticket is for.
  // This gate is the cheap, deterministic safety net: malformed tickets
  // never reach the (paid) generation step.
  const ruleIssues = runDeterministicRules(ticket);
  if (ruleIssues.length > 0) {
    return jsonResponse(
      {
        error: "Ticket failed validation",
        code: "ticket_validation_failed",
        validation: { passed: false, issues: ruleIssues },
      },
      422,
    );
  }

  // 2. Resolve provider. If screenshots are attached, route to a vision-capable
  //    provider (Anthropic > OpenAI > Gemini). Otherwise use the standard
  //    resolution path: request param > session preference > env default.
  const session = await getSession();
  const providerName = provider ?? session.preferred_provider;
  const hasScreenshots = Boolean(screenshots && screenshots.length > 0);
  let llm;
  try {
    llm = hasScreenshots
      ? resolveVisionProvider(providerName)
      : resolveLLMProvider(providerName);
  } catch (e) {
    return errorResponse((e as Error).message, 500);
  }

  // 3. Build prompts. When screenshots are present, append a one-line nudge
  //    so the model knows to integrate them rather than pretend they don't exist.
  const systemPrompt = hasScreenshots
    ? `${buildSystemPrompt(platform, count_hint)}\n\nIMPORTANT: The user has attached one or more UI screenshots. Use them to ground element names, screen labels, and selector identifiers — do NOT invent identifiers that aren't visible in the screenshots or described in text.`
    : buildSystemPrompt(platform, count_hint);
  const userPrompt = buildUserPrompt(ticket, platform, repo_context);

  // 4. Call LLM
  let raw: string;
  try {
    const completion = await llm.complete({
      systemPrompt,
      userPrompt,
      temperature: 0.3,
      jsonMode: true,
      images: screenshots?.map((s) => ({ dataUrl: s.data_url, label: s.label })),
    });
    raw = completion.text;
  } catch (e) {
    return errorResponse(`LLM call failed: ${(e as Error).message}`, 502);
  }

  // 5. Parse JSON
  let parsedRaw: unknown;
  try {
    parsedRaw = JSON.parse(raw);
  } catch {
    return errorResponse(
      "LLM returned invalid JSON",
      500,
      "The model did not return parseable JSON. Try again or switch provider.",
    );
  }

  // The model returns the inner shape; we wrap it into the GenerateResponse envelope.
  const candidate = {
    ticket_id: (parsedRaw as { ticket_id?: string }).ticket_id ?? ticket.ticket_id,
    summary: (parsedRaw as { summary?: string }).summary ?? ticket.summary,
    platform,
    provider: llm.name,
    backend: "typescript" as const,
    generated_test_cases:
      (parsedRaw as { generated_test_cases?: unknown[] }).generated_test_cases ?? [],
  };

  const validated = GenerateResponseSchema.safeParse(candidate);
  if (!validated.success) {
    return errorResponse(
      "LLM output failed schema validation",
      500,
      validated.error.message,
    );
  }

  // 6. Output linter — content quality, not just shape. Reject the batch
  // when any error-severity issue is present. Warnings (e.g. missing edge
  // coverage) are returned as `lint_warnings` so the UI can display them
  // without blocking the user.
  const lintIssues = lintGeneratedCases(validated.data.generated_test_cases, platform);
  const hardFailures = errorsOnly(lintIssues);
  if (hardFailures.length > 0) {
    return jsonResponse(
      {
        error: "Generated test cases failed quality lint",
        code: "output_validation_failed",
        validation: { passed: false, issues: lintIssues },
        partial_response: validated.data,
      },
      422,
    );
  }

  // 7. LLM-as-judge — opt-in, never blocks. Failures are silently swallowed
  // and the user still gets their test cases. Different LLM instance from
  // the generator when possible — JUDGE_PROVIDER env var pins it.
  let quality: QualityScore | undefined;
  if (judge) {
    try {
      const judgeProviderName = process.env.JUDGE_PROVIDER as
        | "openai"
        | "gemini"
        | "anthropic"
        | undefined;
      const { resolveLLMProvider } = await import("@jiraqa/providers");
      const judgeLlm = resolveLLMProvider(judgeProviderName);
      const judgeRes = await judgeLlm.complete({
        systemPrompt: buildJudgeSystemPrompt(),
        userPrompt: buildJudgeUserPrompt(
          ticket,
          platform,
          validated.data.generated_test_cases,
        ),
        temperature: 0.1,
        jsonMode: true,
        maxTokens: 1200,
      });
      quality = parseJudgeResponse(judgeRes.text, judgeLlm.name);
    } catch {
      quality = { score: null, summary: null, per_case_flags: [] };
    }
  }

  const responsePayload: Record<string, unknown> = { ...validated.data };
  if (lintIssues.length > 0) responsePayload.lint_warnings = lintIssues;
  if (quality) responsePayload.quality = quality;
  return jsonResponse(responsePayload);
}
