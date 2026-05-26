/**
 * @module @jiraqa/providers/llm/types
 * The pluggable LLM provider contract. Add a new vendor by implementing this
 * interface and registering it in src/llm/registry.ts — nothing else changes.
 */

/**
 * An image attached to a multimodal request. Always passed as a data URL
 * (e.g. "data:image/png;base64,iVBORw0K...") so the same shape works for
 * every provider — they each format it differently internally.
 */
export interface LLMImageInput {
  dataUrl: string; // "data:image/png;base64,..."
  /** Optional label shown to the model (e.g. "screenshot 1: login screen"). */
  label?: string;
}

export interface LLMCompletionRequest {
  systemPrompt: string;
  userPrompt: string;
  /** Lower = more deterministic. Most providers honour 0.0 - 1.0. */
  temperature?: number;
  /** Request JSON-only output. Providers should enable native JSON mode if available. */
  jsonMode?: boolean;
  /** Hard upper bound on output tokens. */
  maxTokens?: number;
  /** Optional images for multimodal/vision requests. */
  images?: LLMImageInput[];
}

/**
 * Helper used by provider implementations to parse a data URL into the
 * raw base64 payload + media type that vendor APIs expect.
 * Returns null if the input isn't a valid data URL.
 */
export function parseDataUrl(
  dataUrl: string,
): { mediaType: string; base64: string } | null {
  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!m || !m[1] || !m[2]) return null;
  return { mediaType: m[1], base64: m[2] };
}

export interface LLMCompletionResponse {
  /** Raw text from the model — already fence-stripped if the provider knew to do so. */
  text: string;
  /** Model identifier used for the call (for observability). */
  model: string;
  /** Provider name (for observability). */
  provider: string;
  /** Optional token usage breakdown when the provider returns it. */
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export interface LLMProvider {
  /** Unique provider name, e.g. "openai", "gemini". */
  readonly name: string;
  /** Default model id used when none is specified. */
  readonly defaultModel: string;
  /** Returns true if the provider has the credentials it needs to run. */
  isAvailable(): boolean;
  /** Generate a completion. Implementations should throw on transport errors. */
  complete(req: LLMCompletionRequest): Promise<LLMCompletionResponse>;
}
