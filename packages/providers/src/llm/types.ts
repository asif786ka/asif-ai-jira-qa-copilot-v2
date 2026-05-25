/**
 * @module @jiraqa/providers/llm/types
 * The pluggable LLM provider contract. Add a new vendor by implementing this
 * interface and registering it in src/llm/registry.ts — nothing else changes.
 */

export interface LLMCompletionRequest {
  systemPrompt: string;
  userPrompt: string;
  /** Lower = more deterministic. Most providers honour 0.0 - 1.0. */
  temperature?: number;
  /** Request JSON-only output. Providers should enable native JSON mode if available. */
  jsonMode?: boolean;
  /** Hard upper bound on output tokens. */
  maxTokens?: number;
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
