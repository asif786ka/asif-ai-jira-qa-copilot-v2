import { errorResponse, jsonResponse } from "@/lib/utils";
import { jiraFromSession } from "@/lib/providers-from-session";
import { getSession } from "@/lib/session";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const session = await getSession();
  const url = new URL(req.url);
  const projectKey = url.searchParams.get("project") ?? undefined;
  const text = url.searchParams.get("q") ?? undefined;
  const limit = Number(url.searchParams.get("limit") ?? "25");

  try {
    const jira = jiraFromSession(session);
    const issues = await jira.searchIssues({ projectKey, text, limit });
    return jsonResponse({ issues });
  } catch (e) {
    return errorResponse((e as Error).message, 400);
  }
}
