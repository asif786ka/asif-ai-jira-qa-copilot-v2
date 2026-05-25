/**
 * @module @jiraqa/core
 * Shared domain layer — types, schemas, prompts.
 */

export * from "./types";
export * from "./prompts/index";

/**
 * Strip ``` and ```json fences that some LLMs add despite JSON mode.
 * Identical logic to the Python port in apps/api-python/api/openai_client.py.
 */
export function stripFences(raw: string): string {
  return raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
}
