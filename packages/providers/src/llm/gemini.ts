/**
 * @module @jiraqa/providers/llm/gemini
 * Google Gemini implementation of LLMProvider.
 * Uses the v1beta generateContent REST endpoint directly.
 *
 * Why no SDK? Smaller bundle, no vendor lock-in at the SDK level,
 * and Vercel cold-start friendliness.
 */

import { stripFences } from "@jiraqa/core";
import {
  parseDataUrl,
  type LLMCompletionRequest,
  type LLMCompletionResponse,
  type LLMProvider,
} from "./types";

function endpoint(model: string, apiKey: string): string {
  return `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model,
  )}:generateContent?key=${encodeURIComponent(apiKey)}`;
}

export class GeminiProvider implements LLMProvider {
  readonly name = "gemini";
  readonly defaultModel: string;
  private readonly apiKey: string | undefined;

  constructor(opts?: { apiKey?: string; model?: string }) {
    this.apiKey = opts?.apiKey ?? process.env.GEMINI_API_KEY;
    this.defaultModel = opts?.model ?? process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
  }

  isAvailable(): boolean {
    return Boolean(this.apiKey);
  }

  async complete(req: LLMCompletionRequest): Promise<LLMCompletionResponse> {
    if (!this.apiKey) {
      throw new Error(
        "GEMINI_API_KEY is not set. Add it to your environment to use the Gemini provider.",
      );
    }

    // Gemini takes a parts array — each image becomes an inlineData part.
    const userParts: Array<Record<string, unknown>> = [
      { text: req.userPrompt },
    ];
    if (req.images && req.images.length > 0) {
      for (const img of req.images) {
        const parsed = parseDataUrl(img.dataUrl);
        if (!parsed) continue;
        userParts.push({
          inlineData: {
            mimeType: parsed.mediaType,
            data: parsed.base64,
          },
        });
      }
    }

    const body: Record<string, unknown> = {
      systemInstruction: { parts: [{ text: req.systemPrompt }] },
      contents: [{ role: "user", parts: userParts }],
      generationConfig: {
        temperature: req.temperature ?? 0.3,
        ...(req.jsonMode ? { responseMimeType: "application/json" } : {}),
        ...(req.maxTokens ? { maxOutputTokens: req.maxTokens } : {}),
      },
    };

    const res = await fetch(endpoint(this.defaultModel, this.apiKey), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Gemini request failed: ${res.status} ${errText}`);
    }

    const data = (await res.json()) as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
      }>;
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        totalTokenCount?: number;
      };
    };

    const raw = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    return {
      text: stripFences(raw),
      model: this.defaultModel,
      provider: this.name,
      usage: data.usageMetadata
        ? {
            prompt_tokens: data.usageMetadata.promptTokenCount,
            completion_tokens: data.usageMetadata.candidatesTokenCount,
            total_tokens: data.usageMetadata.totalTokenCount,
          }
        : undefined,
    };
  }
}
