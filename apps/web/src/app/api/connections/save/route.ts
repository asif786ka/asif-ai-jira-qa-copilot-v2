/**
 * POST /api/connections/save
 * Persists Jira and/or GitHub creds into the encrypted session cookie.
 * Also caches the GitHub login on success so the UI can show it.
 */

import { z } from "zod";
import { GitHubRestProvider } from "@jiraqa/providers";
import { errorResponse, jsonResponse } from "@/lib/utils";
import { getSession, publicView } from "@/lib/session";

export const runtime = "nodejs";

const Body = z.object({
  jira: z
    .object({
      site_url: z.string().min(1),
      email: z.string().email(),
      api_token: z.string().min(1),
    })
    .optional(),
  github: z
    .object({
      pat: z.string().min(1),
    })
    .optional(),
  preferred_provider: z.enum(["openai", "gemini"]).optional(),
  preferred_backend: z.enum(["typescript", "python"]).optional(),
});

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return errorResponse("Invalid request body", 400, parsed.error.message);
  }
  const { jira, github, preferred_provider, preferred_backend } = parsed.data;

  const session = await getSession();
  if (jira) session.jira = jira;
  if (github) {
    let login: string | undefined;
    try {
      const ping = await new GitHubRestProvider({ pat: github.pat }).ping();
      if (ping.ok) login = ping.login;
    } catch {
      // Save anyway — user may have a token with restricted scopes that doesn't allow /user.
    }
    session.github = { pat: github.pat, login };
  }
  if (preferred_provider) session.preferred_provider = preferred_provider;
  if (preferred_backend) session.preferred_backend = preferred_backend;

  await session.save();
  return jsonResponse({ ok: true, session: publicView(session) });
}

export async function GET() {
  const session = await getSession();
  return jsonResponse({ session: publicView(session) });
}
