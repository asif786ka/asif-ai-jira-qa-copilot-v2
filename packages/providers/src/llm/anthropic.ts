/**
 * @module @jiraqa/providers/llm/anthropic
 * Anthropic Claude implementation of LLMProvider.
 * Uses the Messages API directly (no SDK) for a small bundle.
 *
 * Why we have this: Claude Sonnet 4.5 is the best model for generating
 * compilable XCUITest (Swift) and Espresso (Kotlin) code — markedly better
 * than Gemini Flash or gpt-4o-mini at less-common framework APIs. We route
 * mobile code generation to Claude in the smart-router.
 */

import { stripFences } from "@jiraqa/core";
import {
  parseDataUrl,
  type LLMCompletionRequest,
  type LLMCompletionResponse,
  type LLMProvider,
} from "./types";

const ENDPOINT = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  readonly defaultModel: string;
  private readonly apiKey: string | undefined;

  constructor(opts?: { apiKey?: string; model?: string }) {
    this.apiKey = opts?.apiKey ?? process.env.ANTHROPIC_API_KEY;
    this.defaultModel =
      opts?.model ?? process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5";
  }

  isAvailable(): boolean {
    return Boolean(this.apiKey);
  }

  async complete(req: LLMCompletionRequest): Promise<LLMCompletionResponse> {
    if (!this.apiKey) {
      throw new Error(
        "ANTHROPIC_API_KEY is not set. Add it to your environment to use the Anthropic provider.",
      );
    }

    // Claude doesn't have a native "json mode" toggle but responds well when
    // the system prompt requires JSON output. We append a strict instruction
    // to the system prompt and rely on it.
    const systemPrompt = req.jsonMode
      ? `${req.systemPrompt}\n\nRespond with ONLY the JSON object — no prose, no markdown fences.`
      : req.systemPrompt;

    // Anthropic uses a content array of blocks. Each image becomes an
    // {type:"image", source:{type:"base64", media_type, data}} block.
    const userContent: Array<Record<string, unknown>> = [];
    if (req.images && req.images.length > 0) {
      for (const img of req.images) {
        const parsed = parseDataUrl(img.dataUrl);
        if (!parsed) continue;
        userContent.push({
          type: "image",
          source: {
            type: "base64",
            media_type: parsed.mediaType,
            data: parsed.base64,
          },
        });
      }
    }
    userContent.push({ type: "text", text: req.userPrompt });

    const body: Record<string, unknown> = {
      model: this.defaultModel,
      max_tokens: req.maxTokens ?? 4096,
      temperature: req.temperature ?? 0.3,
      system: systemPrompt,
      messages: [{ role: "user", content: userContent }],
    };

    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": API_VERSION,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Anthropic request failed: ${res.status} ${errText}`);
    }

    const data = (await res.json()) as {
      content?: Array<{ type: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };

    const raw =
      data.content
        ?.filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("") ?? "";

    return {
      text: stripFences(raw),
      model: this.defaultModel,
      provider: this.name,
      usage: data.usage
        ? {
            prompt_tokens: data.usage.input_tokens,
            completion_tokens: data.usage.output_tokens,
            total_tokens:
              (data.usage.input_tokens ?? 0) + (data.usage.output_tokens ?? 0),
          }
        : undefined,
    };
  }
}
