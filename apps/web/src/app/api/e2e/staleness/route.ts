/**
 * GET /api/e2e/staleness?main_owner=&main_repo=
 *
 * Phase 13.2 Tier 2 — staleness detection.
 *
 * For the given main app repo, locate the conventional e2e repo
 * (<main_repo>-<platform>-e2e for any platform with saved conventions),
 * list the generated test flow files, parse their markers to extract the
 * source SHA each was generated against, and compare those SHAs to the
 * current HEAD of the main repo.
 *
 * Response shape:
 *   {
 *     main_repo: "<owner>/<repo>",
 *     main_head_sha: "abc123...",
 *     suites: [
 *       {
 *         platform: "ios",
 *         e2e_repo: "<user>/<main_repo>-ios-e2e",
 *         tests: [
 *           {
 *             path: "e2e/flows/KAN-2.yaml",
 *             ticket_id: "KAN-2",
 *             source_sha: "abc123",
 *             generated_at: "2026-...",
 *             stale: true,
 *             hand_edited: false,
 *           }, ...
 *         ]
 *       }
 *     ]
 *   }
 */

import { parseMarker } from "@jiraqa/core";
import { errorResponse, jsonResponse } from "@/lib/utils";
import { githubFromSession } from "@/lib/providers-from-session";
import { getSession } from "@/lib/session";

export const runtime = "nodejs";

interface TestEntry {
  path: string;
  ticket_id?: string;
  source_sha?: string;
  generated_at?: string;
  /** true = main repo HEAD differs from the stamped SHA. */
  stale: boolean;
  /** true = marker line is missing / altered — file was hand-edited. */
  hand_edited: boolean;
  /** Branch this file currently lives on. "main" = merged; "jiraqa/<key>" = pending PR. */
  branch: string;
}

interface SuiteEntry {
  platform: string;
  e2e_repo: string;
  tests: TestEntry[];
}

export async function GET(req: Request) {
  const session = await getSession();
  const url = new URL(req.url);
  const owner = url.searchParams.get("main_owner");
  const repo = url.searchParams.get("main_repo");
  if (!owner || !repo) {
    return errorResponse("Missing ?main_owner=&main_repo=", 400);
  }

  try {
    const gh = githubFromSession(session);

    // Current HEAD of the main repo — try "main" then "master".
    let mainHeadSha = "";
    try {
      mainHeadSha = await gh.getBranchSha(owner, repo, "main");
    } catch {
      try {
        mainHeadSha = await gh.getBranchSha(owner, repo, "master");
      } catch {
        // continue with empty — we'll just report all tests as stale-unknown
      }
    }

    // Look up the user's login (the e2e repos live under their namespace).
    const ping = await gh.ping();
    if (!ping.ok) return errorResponse(`GitHub auth failed: ${ping.error}`, 401);
    const me = ping.login;

    // Which platforms might have an e2e repo? We check the three conventions.
    const suites: SuiteEntry[] = [];
    for (const platform of ["ios", "android", "web"] as const) {
      const e2eRepoName = `${repo}-${platform}-e2e`;
      const exists = await gh.repoExists(me, e2eRepoName);
      if (!exists) continue;

      // Collect all branches that may contain generated tests:
      //   • main — the merged/canonical state
      //   • jiraqa/* — open PR branches with unmerged tests
      const branchesToScan: string[] = ["main"];
      const jiraqaBranches = await gh.listBranches({
        owner: me,
        repo: e2eRepoName,
        prefix: "jiraqa/",
      });
      branchesToScan.push(...jiraqaBranches.map((b) => b.name));

      // Scan each branch. Dedupe by path — main beats a branch if both
      // contain the same file (the merged version is canonical).
      const seen = new Map<string, TestEntry>();
      for (const branch of branchesToScan) {
        const entries = await gh.listDirectory({
          owner: me,
          repo: e2eRepoName,
          branch,
          path: "e2e/flows",
        });
        for (const entry of entries) {
          if (entry.type !== "file") continue;
          // If main already produced an entry for this path, keep it.
          if (seen.has(entry.path) && seen.get(entry.path)!.branch === "main")
            continue;

          const content = await gh.getFileContent({
            owner: me,
            repo: e2eRepoName,
            branch,
            path: entry.path,
          });
          if (content === null) continue;

          const marker = parseMarker(content);
          if (!marker) {
            seen.set(entry.path, {
              path: entry.path,
              stale: false,
              hand_edited: true,
              branch,
            });
            continue;
          }
          const stamped = marker.source_sha ?? "";
          const stale =
            mainHeadSha !== "" &&
            stamped !== "" &&
            !mainHeadSha.startsWith(stamped);
          seen.set(entry.path, {
            path: entry.path,
            ticket_id: marker.ticket_id,
            source_sha: marker.source_sha,
            generated_at: marker.generated_at,
            stale,
            hand_edited: false,
            branch,
          });
        }
      }

      suites.push({
        platform,
        e2e_repo: `${me}/${e2eRepoName}`,
        tests: Array.from(seen.values()),
      });
    }

    return jsonResponse({
      main_repo: `${owner}/${repo}`,
      main_head_sha: mainHeadSha,
      suites,
    });
  } catch (e) {
    return errorResponse((e as Error).message, 500);
  }
}
