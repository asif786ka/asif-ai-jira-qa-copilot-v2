/**
 * GET /api/github/detect-conventions?owner=&repo=&platform=
 *
 * Auto-detect E2E conventions for the given repo+platform. Returns a
 * partial RepoConventions object that the wizard uses as pre-filled
 * smart defaults.
 */

import { detectConventionsFromContext } from "@jiraqa/providers";
import { PlatformSchema } from "@jiraqa/core";
import { errorResponse, jsonResponse } from "@/lib/utils";
import { githubFromSession } from "@/lib/providers-from-session";
import { getSession } from "@/lib/session";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const session = await getSession();
  const url = new URL(req.url);
  const owner = url.searchParams.get("owner");
  const repo = url.searchParams.get("repo");
  const platformRaw = url.searchParams.get("platform");

  if (!owner || !repo) return errorResponse("Missing ?owner=&repo=", 400);
  const platformParse = PlatformSchema.safeParse(platformRaw);
  if (!platformParse.success) {
    return errorResponse("Invalid ?platform= (android | ios | web)", 400);
  }

  try {
    const gh = githubFromSession(session);
    const context = await gh.buildContext(owner, repo);
    const detected = detectConventionsFromContext(context, platformParse.data);
    return jsonResponse({
      detected,
      detected_platforms: context.detected_platforms,
      default_branch: context.default_branch,
    });
  } catch (e) {
    return errorResponse((e as Error).message, 400);
  }
}
