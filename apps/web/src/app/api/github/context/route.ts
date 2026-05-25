/**
 * GET /api/github/context?owner=<>&repo=<>
 * Returns a curated RepoContext (README excerpt + key files + detected platforms).
 */

import { errorResponse, jsonResponse } from "@/lib/utils";
import { githubFromSession } from "@/lib/providers-from-session";
import { getSession } from "@/lib/session";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const session = await getSession();
  const url = new URL(req.url);
  const owner = url.searchParams.get("owner");
  const repo = url.searchParams.get("repo");
  if (!owner || !repo) return errorResponse("Missing ?owner=<>&repo=<>", 400);
  try {
    const gh = githubFromSession(session);
    const context = await gh.buildContext(owner, repo);
    return jsonResponse({ context });
  } catch (e) {
    return errorResponse((e as Error).message, 400);
  }
}
