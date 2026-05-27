/**
 * GET /api/dora/metrics?owner=&repo=&project=&days=30
 *
 * Phase 14.1 — computes the four DORA metrics for a given main repo +
 * (optional) Jira project, over a rolling window.
 *
 * Deployment Frequency  = merged PRs to main / weeks_in_window
 * Lead Time for Changes = average (pr.merged_at - pr.created_at) across merged PRs
 * Change Failure Rate   = incidents created within window / merged PRs in window
 * MTTR                  = average (resolved - created) of resolved incidents
 *
 * The endpoint is read-only — it does not mutate any user state. Heavy on
 * Jira+GitHub API calls though; caching is a TODO for Phase 14.4.
 */

import { z } from "zod";
import {
  classifyChangeFailureRate,
  classifyDeploymentFrequency,
  classifyLeadTime,
  classifyMTTR,
  formatHours,
  formatPerWeek,
  type DoraResponse,
} from "@jiraqa/core";
import { errorResponse, jsonResponse } from "@/lib/utils";
import {
  githubFromSession,
  jiraFromSession,
} from "@/lib/providers-from-session";
import { getSession } from "@/lib/session";

export const runtime = "nodejs";
export const maxDuration = 60;

const Query = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  project: z.string().optional(),
  days: z.coerce.number().int().min(1).max(365).default(30),
});

export async function GET(req: Request) {
  const session = await getSession();
  const url = new URL(req.url);
  const parsed = Query.safeParse({
    owner: url.searchParams.get("owner"),
    repo: url.searchParams.get("repo"),
    project: url.searchParams.get("project") ?? undefined,
    days: url.searchParams.get("days") ?? undefined,
  });
  if (!parsed.success) {
    return errorResponse("Invalid query parameters", 400, parsed.error.message);
  }
  const { owner, repo, project, days } = parsed.data;

  if (!session.github) return errorResponse("GitHub is not connected.", 400);
  if (!session.jira)
    return errorResponse("Jira is not connected. Connect it to compute DORA.", 400);

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const windowWeeks = days / 7;

  try {
    const gh = githubFromSession(session);
    const jira = jiraFromSession(session);

    // ── Parallel fetch — saves several seconds on cold runs ──────────────
    const [mergedPRs, incidents, mainHeadSha] = await Promise.all([
      gh.listMergedPRs({ owner, repo, since, limit: 100 }),
      jira.listIncidents({ projectKey: project, since, limit: 100 }),
      gh
        .buildContext(owner, repo)
        .then((c) => c.default_branch)
        .catch(() => "main"),
    ]);

    // ── Deployment Frequency ─────────────────────────────────────────────
    const deployCount = mergedPRs.length;
    const deploysPerWeek = deployCount / windowWeeks;

    // ── Lead Time for Changes (PR created → merged) ──────────────────────
    let leadTimeHours: number | null = null;
    if (mergedPRs.length > 0) {
      const totalHours = mergedPRs.reduce((sum, p) => {
        const ms =
          new Date(p.merged_at).getTime() - new Date(p.created_at).getTime();
        return sum + ms / (1000 * 60 * 60);
      }, 0);
      leadTimeHours = totalHours / mergedPRs.length;
    }

    // ── Change Failure Rate ──────────────────────────────────────────────
    // Simple v1 proxy: total incidents in window / total deploys in window.
    // A more sophisticated v2 would correlate each incident to a specific
    // deploy (e.g., incident created within 72h of a deploy = caused by it).
    const changeFailureRate =
      deployCount > 0 ? incidents.length / deployCount : null;

    // ── MTTR (resolved incidents only) ───────────────────────────────────
    const resolvedIncidents = incidents.filter((i) => i.resolved);
    let mttrHours: number | null = null;
    if (resolvedIncidents.length > 0) {
      const totalMs = resolvedIncidents.reduce((sum, i) => {
        return (
          sum +
          (new Date(i.resolved!).getTime() - new Date(i.created).getTime())
        );
      }, 0);
      mttrHours = totalMs / resolvedIncidents.length / (1000 * 60 * 60);
    }

    const response: DoraResponse = {
      window_days: days,
      source: {
        main_repo: `${owner}/${repo}`,
        jira_project: project,
      },
      deployment_frequency: {
        value: deploysPerWeek,
        unit: "per week",
        tier: classifyDeploymentFrequency(deploysPerWeek),
        description: `${deployCount} merges over ${days} days (${formatPerWeek(deploysPerWeek)})`,
      },
      lead_time_hours: {
        value: leadTimeHours,
        unit: "hours",
        tier:
          leadTimeHours !== null ? classifyLeadTime(leadTimeHours) : "unknown",
        description:
          leadTimeHours !== null
            ? `Average PR open → merge: ${formatHours(leadTimeHours)}`
            : "No merged PRs in this window",
      },
      change_failure_rate: {
        value: changeFailureRate,
        unit: "ratio",
        tier:
          changeFailureRate !== null
            ? classifyChangeFailureRate(changeFailureRate)
            : "unknown",
        description:
          changeFailureRate !== null
            ? `${incidents.length} incidents / ${deployCount} deploys = ${(changeFailureRate * 100).toFixed(0)}%`
            : "Not enough data — need at least one merged PR in the window",
      },
      mttr_hours: {
        value: mttrHours,
        unit: "hours",
        tier: mttrHours !== null ? classifyMTTR(mttrHours) : "unknown",
        description:
          mttrHours !== null
            ? `${resolvedIncidents.length} resolved incidents · average ${formatHours(mttrHours)}`
            : `${incidents.length} incidents open, none resolved yet in this window`,
      },
      sample: {
        merged_prs: mergedPRs.length,
        incidents: incidents.length,
        resolved_incidents: resolvedIncidents.length,
      },
    };

    // We don't actually use mainHeadSha in the response shape currently, but
    // surface it so the UI can show "fresh as of <sha>" if it wants.
    if (mainHeadSha) {
      response.source.main_head_sha = mainHeadSha;
    }

    return jsonResponse(response);
  } catch (e) {
    return errorResponse((e as Error).message, 500);
  }
}
