/**
 * POST /api/connections/test
 * Validates Jira and/or GitHub creds WITHOUT persisting them. Used by the
 * Connections UI "Test connection" button.
 */

import { z } from "zod";
import { GitHubRestProvider, JiraCloudProvider } from "@jiraqa/providers";
import { errorResponse, jsonResponse } from "@/lib/utils";

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
});

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return errorResponse("Invalid request body", 400, parsed.error.message);
  }

  const { jira, github } = parsed.data;
  const result: Record<string, unknown> = {};

  if (jira) {
    const p = new JiraCloudProvider({
      siteUrl: jira.site_url,
      email: jira.email,
      apiToken: jira.api_token,
    });
    result.jira = await p.ping();
  }
  if (github) {
    const p = new GitHubRestProvider({ pat: github.pat });
    result.github = await p.ping();
  }

  return jsonResponse(result);
}
