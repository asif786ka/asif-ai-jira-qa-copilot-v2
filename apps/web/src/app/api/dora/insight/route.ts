/**
 * POST /api/dora/insight
 *
 * Phase 14.3 — generate a short, actionable bottleneck-analysis insight
 * from the four DORA numbers + sample sizes. Cheap to run: ~$0.005 on
 * Gemini Flash (text-only, ~500 tokens out).
 *
 * Body: { metrics: DoraResponse }
 * Response: { insight: string, provider: string }
 */

import { z } from "zod";
import { DoraResponseSchema } from "@jiraqa/core";
import { resolveLLMProvider } from "@jiraqa/providers";
import { errorResponse, jsonResponse } from "@/lib/utils";

export const runtime = "nodejs";

const Body = z.object({ metrics: DoraResponseSchema });

const SYSTEM_PROMPT = `You are a senior engineering manager who reads DORA metrics dashboards.
Given the four numbers below, write a SHORT (2-4 sentence) plain-English
analysis identifying the team's primary bottleneck and one concrete
suggestion to improve it. Be specific. No hedging, no bullet points, no
markdown. Reference the actual numbers.

DORA tier reminders:
  Deployment Frequency: Elite >1/day, High >1/week, Medium >1/month, Low <1/month
  Lead Time: Elite <1d, High <1w, Medium <1m, Low >1m
  Change Failure Rate: Elite/High 0-15%, Medium 15-30%, Low >30%
  MTTR: Elite <1h, High <1d, Medium <1w, Low >1w

Frame the answer as if speaking directly to the team's engineering lead.`;

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return errorResponse("Invalid body", 400, parsed.error.message);
  }
  const m = parsed.data.metrics;

  let llm;
  try {
    llm = resolveLLMProvider();
  } catch (e) {
    return errorResponse((e as Error).message, 500);
  }

  const summary = [
    `Window: last ${m.window_days} days · repo: ${m.source.main_repo}`,
    ``,
    `Deployment Frequency: ${m.deployment_frequency.description} → tier ${m.deployment_frequency.tier}`,
    `Lead Time: ${m.lead_time_hours.description} → tier ${m.lead_time_hours.tier}`,
    `Change Failure Rate: ${m.change_failure_rate.description} → tier ${m.change_failure_rate.tier}`,
    `MTTR: ${m.mttr_hours.description} → tier ${m.mttr_hours.tier}`,
    ``,
    `Sample: ${m.sample.merged_prs} merged PRs, ${m.sample.incidents} incidents, ${m.sample.resolved_incidents} resolved.`,
  ].join("\n");

  try {
    const completion = await llm.complete({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: summary,
      temperature: 0.4,
      jsonMode: false,
      maxTokens: 400,
    });
    return jsonResponse({
      insight: completion.text.trim(),
      provider: llm.name,
      model: llm.defaultModel,
    });
  } catch (e) {
    return errorResponse(`LLM call failed: ${(e as Error).message}`, 502);
  }
}
