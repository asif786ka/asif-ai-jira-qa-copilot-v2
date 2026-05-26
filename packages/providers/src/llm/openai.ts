/**
 * @module @jiraqa/providers/llm/openai
 * OpenAI implementation of LLMProvider.
 * Uses the REST API directly (no SDK) to keep the dependency tree small
 * and the bundle Vercel-friendly.
 */

import { stripFences } from "@jiraqa/core";
import type {
  LLMCompletionRequest,
  LLMCompletionResponse,
  LLMProvider,
} from "./types";

const ENDPOINT = "https://api.openai.com/v1/chat/completions";

export class OpenAIProvider implements LLMProvider {
  readonly name = "openai";
  readonly defaultModel: string;
  private readonly apiKey: string | undefined;

  constructor(opts?: { apiKey?: string; model?: string }) {
    this.apiKey = opts?.apiKey ?? process.env.OPENAI_API_KEY;
    this.defaultModel = opts?.model ?? process.env.OPENAI_MODEL ?? "gpt-4o-mini";
  }

  isAvailable(): boolean {
    return Boolean(this.apiKey);
  }

  async complete(req: LLMCompletionRequest): Promise<LLMCompletionResponse> {
    if (!this.apiKey) {
      throw new Error(
        "OPENAI_API_KEY is not set. Add it to your environment to use the OpenAI provider.",
      );
    }

    // Build user-message content. If images are attached we send a content
    // array with mixed text + image_url parts; otherwise a plain string.
    const userContent =
      req.images && req.images.length > 0
        ? [
            { type: "text", text: req.userPrompt },
            ...req.images.map((img) => ({
              type: "image_url",
              image_url: { url: img.dataUrl },
            })),
          ]
        : req.userPrompt;

    const body: Record<string, unknown> = {
      model: this.defaultModel,
      temperature: req.temperature ?? 0.3,
      messages: [
        { role: "system", content: req.systemPrompt },
        { role: "user", content: userContent },
      ],
    };
    if (req.jsonMode) body.response_format = { type: "json_object" };
    if (req.maxTokens) body.max_tokens = req.maxTokens;

    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`OpenAI request failed: ${res.status} ${errText}`);
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: LLMCompletionResponse["usage"];
    };

    const raw = data.choices?.[0]?.message?.content ?? "";
    return {
      text: stripFences(raw),
      model: this.defaultModel,
      provider: this.name,
      usage: data.usage,
    };
  }
}
