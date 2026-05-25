import { errorResponse, jsonResponse } from "@/lib/utils";
import { githubFromSession } from "@/lib/providers-from-session";
import { getSession } from "@/lib/session";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const session = await getSession();
  const url = new URL(req.url);
  const limit = Number(url.searchParams.get("limit") ?? "50");
  try {
    const gh = githubFromSession(session);
    const repos = await gh.listRepos({ limit });
    return jsonResponse({ repos });
  } catch (e) {
    return errorResponse((e as Error).message, 400);
  }
}
