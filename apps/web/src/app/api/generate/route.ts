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
  buildSystemPrompt,
  buildUserPrompt,
} from "@jiraqa/core";
import { resolveLLMProvider } from "@jiraqa/providers";
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
  const { ticket, platform, repo_context, provider, count_hint } = parsed.data;

  // 2. Resolve provider — request param > session preference > env default
  const session = await getSession();
  const providerName = provider ?? session.preferred_provider;
  let llm;
  try {
    llm = resolveLLMProvider(providerName);
  } catch (e) {
    return errorResponse((e as Error).message, 500);
  }

  // 3. Build prompts
  const systemPrompt = buildSystemPrompt(platform, count_hint);
  const userPrompt = buildUserPrompt(ticket, platform, repo_context);

  // 4. Call LLM
  let raw: string;
  try {
    const completion = await llm.complete({
      systemPrompt,
      userPrompt,
      temperature: 0.3,
      jsonMode: true,
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
  return jsonResponse(validated.data);
}
