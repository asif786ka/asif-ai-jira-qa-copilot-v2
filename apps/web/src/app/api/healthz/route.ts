import { jsonResponse } from "@/lib/utils";
import { listLLMProviders, resolveLLMProvider } from "@jiraqa/providers";

export const runtime = "nodejs";

export async function GET() {
  let llmAvailable = false;
  let llmProvider: string | null = null;
  try {
    const p = resolveLLMProvider();
    llmAvailable = p.isAvailable();
    llmProvider = p.name;
  } catch {
    // No provider configured — still healthy from the server's POV.
  }
  return jsonResponse({
    ok: true,
    backend: "typescript",
    llm: { available: llmAvailable, default_provider: llmProvider, registered: listLLMProviders() },
    timestamp: new Date().toISOString(),
  });
}
