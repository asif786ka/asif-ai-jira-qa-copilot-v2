import { errorResponse, jsonResponse } from "@/lib/utils";
import { jiraFromSession } from "@/lib/providers-from-session";
import { getSession } from "@/lib/session";

export const runtime = "nodejs";

export async function GET() {
  const session = await getSession();
  try {
    const jira = jiraFromSession(session);
    const projects = await jira.listProjects();
    return jsonResponse({ projects });
  } catch (e) {
    return errorResponse((e as Error).message, 400);
  }
}
