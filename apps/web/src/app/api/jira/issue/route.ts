import { errorResponse, jsonResponse } from "@/lib/utils";
import { jiraFromSession } from "@/lib/providers-from-session";
import { getSession } from "@/lib/session";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const session = await getSession();
  const url = new URL(req.url);
  const key = url.searchParams.get("key");
  if (!key) return errorResponse("Missing ?key=<JIRA-KEY>", 400);

  try {
    const jira = jiraFromSession(session);
    const ticket = await jira.getIssue(key);
    return jsonResponse({ ticket });
  } catch (e) {
    return errorResponse((e as Error).message, 400);
  }
}
