/**
 * POST /api/generate-code
 *
 * Stage-2 generation: turns an array of TestCase objects into executable
 * test code (Maestro YAML, XCUITest Swift, or Espresso Kotlin) using the
 * smart-routed LLM provider from buildCodeGenSpec.
 *
 * Request body:
 *   {
 *     ticket: JiraTicket,
 *     test_cases: TestCase[],
 *     conventions: RepoConventions,
 *     provider_override?: "openai" | "gemini" | "anthropic"
 *   }
 *
 * Response:
 *   {
 *     code: string,                // the generated file content
 *     filename: string,
 *     destination_path: string,
 *     provider: string,
 *     model: string,
 *   }
 */

import { z } from "zod";
import {
  JiraTicketSchema,
  RepoConventionsSchema,
  TestCaseSchema,
  buildCodeGenSpec,
} from "@jiraqa/core";
import { getLLMProvider, resolveLLMProvider } from "@jiraqa/providers";
import { errorResponse, jsonResponse } from "@/lib/utils";

export const runtime = "nodejs";
export const maxDuration = 60;

const Body = z.object({
  ticket: JiraTicketSchema,
  test_cases: z.array(TestCaseSchema).min(1).max(8),
  conventions: RepoConventionsSchema,
  provider_override: z.enum(["openai", "gemini", "anthropic"]).optional(),
});

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return errorResponse("Invalid request body", 400, parsed.error.message);
  }

  const { ticket, test_cases, conventions, provider_override } = parsed.data;

  // 1. Build the code-gen spec — picks recommended provider + filename
  const spec = buildCodeGenSpec(ticket, test_cases, conventions);

  // 2. Resolve LLM provider. Try recommended first; fall back to whatever
  //    is available if the recommended provider isn't configured.
  const providerName = provider_override ?? spec.recommendedProvider;
  let llm;
  try {
    const candidate = getLLMProvider(providerName);
    llm = candidate.isAvailable() ? candidate : resolveLLMProvider();
  } catch {
    try {
      llm = resolveLLMProvider();
    } catch (e) {
      return errorResponse((e as Error).message, 500);
    }
  }

  // 3. Call the LLM with the code-gen spec.
  let code: string;
  try {
    const completion = await llm.complete({
      systemPrompt: spec.systemPrompt,
      userPrompt: spec.userPrompt,
      temperature: 0.2, // lower for code — we want determinism
      jsonMode: spec.jsonMode,
      maxTokens: 4000,
    });
    code = completion.text;
  } catch (e) {
    return errorResponse(`LLM call failed: ${(e as Error).message}`, 502);
  }

  // 4. Basic sanity: code shouldn't be empty
  if (!code || code.trim().length < 20) {
    return errorResponse(
      "LLM returned empty or near-empty output",
      500,
      "Try again or switch provider.",
    );
  }

  return jsonResponse({
    code,
    filename: spec.filename,
    destination_path: spec.destinationPath,
    provider: llm.name,
    model: llm.defaultModel,
    test_format: conventions.test_format,
  });
}
