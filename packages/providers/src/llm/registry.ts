/**
 * @module @jiraqa/providers/llm/registry
 * Provider registry — the pluggability layer.
 *
 * To add a new vendor:
 *   1. Create a new file implementing LLMProvider.
 *   2. Register it below via `registerLLMProvider(...)`.
 *   3. Add its name to the union in @jiraqa/core/types `GenerateRequest.provider`.
 *
 * Resolution order for `resolveLLMProvider()`:
 *   1. Explicit name passed in.
 *   2. DEFAULT_LLM_PROVIDER env var.
 *   3. First registered provider that reports isAvailable() === true.
 */

import { GeminiProvider } from "./gemini";
import { OpenAIProvider } from "./openai";
import type { LLMProvider } from "./types";

const registry = new Map<string, () => LLMProvider>();

export function registerLLMProvider(name: string, factory: () => LLMProvider): void {
  registry.set(name, factory);
}

export function listLLMProviders(): string[] {
  return Array.from(registry.keys());
}

export function getLLMProvider(name: string): LLMProvider {
  const factory = registry.get(name);
  if (!factory) {
    throw new Error(
      `Unknown LLM provider "${name}". Registered: ${listLLMProviders().join(", ") || "(none)"}.`,
    );
  }
  return factory();
}

export function resolveLLMProvider(explicit?: string): LLMProvider {
  const preferred = explicit ?? process.env.DEFAULT_LLM_PROVIDER ?? "openai";
  if (registry.has(preferred)) {
    const p = getLLMProvider(preferred);
    if (p.isAvailable()) return p;
  }
  // Fall back to the first available registered provider.
  for (const name of registry.keys()) {
    const p = getLLMProvider(name);
    if (p.isAvailable()) return p;
  }
  throw new Error(
    "No LLM provider is available. Set OPENAI_API_KEY or GEMINI_API_KEY in your environment.",
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Default registrations
// ────────────────────────────────────────────────────────────────────────────
registerLLMProvider("openai", () => new OpenAIProvider());
registerLLMProvider("gemini", () => new GeminiProvider());
