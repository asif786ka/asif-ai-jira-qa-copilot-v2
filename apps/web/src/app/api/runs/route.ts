/**
 * GET /api/runs
 *
 * Lists recent GitHub Actions workflow runs across all E2E repos the user
 * has configured. For each repo in session.repo_conventions, we resolve
 * the e2e repo name and fetch the most recent runs via GitHub's API.
 *
 * Used by /runs (the dashboard) to render an at-a-glance history of every
 * test execution the JiraQA system has kicked off — including success rate,
 * ticket key, repair attempts, and direct links to artifacts.
 *
 * Response shape:
 * {
 *   runs: Array<{
 *     run_id: number,
 *     repo: string,             // "owner/name"
 *     workflow_name: string,
 *     status: "queued" | "in_progress" | "completed",
 *     conclusion: string | null, // "success" | "failure" | "cancelled" | null
 *     created_at: string,
 *     updated_at: string,
 *     html_url: string,
 *     ticket_id: string | null,  // extracted from the head branch name
 *     head_branch: string,
 *     event: string,             // "pull_request" | "push" | etc.
 *     duration_ms: number | null,
 *   }>,
 *   repos_scanned: string[],
 *   errors: Array<{ repo: string, message: string }>,
 * }
 */

import { getSession } from "@/lib/session";
import { errorResponse, jsonResponse } from "@/lib/utils";

export const runtime = "nodejs";

interface GhRun {
  id: number;
  name: string | null;
  status: string;
  conclusion: string | null;
  html_url: string;
  created_at: string;
  updated_at: string;
  head_branch: string;
  event: string;
  run_started_at: string | null;
}

interface GhRunsResponse {
  total_count: number;
  workflow_runs: GhRun[];
}

const GH_API = "https://api.github.com";

export async function GET() {
  const session = await getSession();
  if (!session.github?.pat) {
    return errorResponse("GitHub is not connected.", 401);
  }
  const pat = session.github.pat;

  // ── Resolve the set of (owner, e2e_repo_name) pairs to scan ──────────
  // session.repo_conventions is keyed by "main_owner/main_repo" → RepoConventions.
  // Each conventions object carries an e2e_repo_name. We dedupe and assume
  // the e2e repo lives in the authenticated user's namespace (matches how
  // /api/e2e/generate-pr creates them — see runGeneratePr step 4).
  const me = session.github.login ?? null;
  if (!me) {
    return errorResponse(
      "Could not determine the GitHub login for the connected token.",
      500,
    );
  }

  const e2eRepoNames = new Set<string>();
  for (const conv of Object.values(session.repo_conventions ?? {})) {
    const name = conv?.e2e_repo_name;
    if (name) e2eRepoNames.add(name);
  }

  if (e2eRepoNames.size === 0) {
    return jsonResponse({ runs: [], repos_scanned: [], errors: [] });
  }

  const reposScanned: string[] = [];
  const errors: Array<{ repo: string; message: string }> = [];
  const allRuns: Array<{
    run_id: number;
    repo: string;
    workflow_name: string;
    status: string;
    conclusion: string | null;
    created_at: string;
    updated_at: string;
    html_url: string;
    ticket_id: string | null;
    head_branch: string;
    event: string;
    duration_ms: number | null;
  }> = [];

  for (const repoName of e2eRepoNames) {
    const fullName = `${me}/${repoName}`;
    reposScanned.push(fullName);
    try {
      const res = await fetch(
        `${GH_API}/repos/${encodeURIComponent(me)}/${encodeURIComponent(repoName)}/actions/runs?per_page=10`,
        {
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${pat}`,
            "x-github-api-version": "2022-11-28",
          },
        },
      );
      if (!res.ok) {
        const detail = (await res.text()).slice(0, 300);
        errors.push({ repo: fullName, message: `HTTP ${res.status}: ${detail}` });
        continue;
      }
      const data = (await res.json()) as GhRunsResponse;
      for (const r of data.workflow_runs) {
        // Branch convention from generate-pr: `jiraqa/<ticket-id-slug>`.
        // Pull the ticket key back out so the dashboard can show it.
        let ticket_id: string | null = null;
        const m = /^jiraqa\/(.+)$/.exec(r.head_branch || "");
        if (m && m[1]) ticket_id = m[1].toUpperCase();

        let duration_ms: number | null = null;
        if (r.run_started_at && r.updated_at) {
          const start = Date.parse(r.run_started_at);
          const end = Date.parse(r.updated_at);
          if (!Number.isNaN(start) && !Number.isNaN(end) && end >= start) {
            duration_ms = end - start;
          }
        }

        allRuns.push({
          run_id: r.id,
          repo: fullName,
          workflow_name: r.name ?? "workflow",
          status: r.status,
          conclusion: r.conclusion,
          created_at: r.created_at,
          updated_at: r.updated_at,
          html_url: r.html_url,
          ticket_id,
          head_branch: r.head_branch,
          event: r.event,
          duration_ms,
        });
      }
    } catch (e) {
      errors.push({ repo: fullName, message: (e as Error).message });
    }
  }

  // Newest first.
  allRuns.sort((a, b) =>
    a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0,
  );

  return jsonResponse({
    runs: allRuns,
    repos_scanned: reposScanned,
    errors,
  });
}
