/**
 * Per-repo E2E test conventions API.
 *
 *   GET  /api/conventions?owner=&repo=     → returns stored conventions or null
 *   PUT  /api/conventions                   → saves conventions for a repo
 *   DELETE /api/conventions?owner=&repo=    → clears conventions for a repo
 *
 * Storage is the encrypted session cookie (iron-session). Keyed by
 * "<owner>/<repo>" so a user with multiple connected repos can have
 * independent conventions per repo.
 *
 * SaaS upgrade path: when we add real accounts, swap the cookie read
 * with a SELECT from a `repo_conventions` table keyed by (user_id, repo).
 * The wire contract here doesn't change.
 */

import { z } from "zod";
import { RepoConventionsSchema } from "@jiraqa/core";
import { errorResponse, jsonResponse } from "@/lib/utils";
import { getSession } from "@/lib/session";

export const runtime = "nodejs";

function repoKey(owner: string, repo: string): string {
  return `${owner}/${repo}`;
}

// ────────────────────────────────────────────────────────────────────────────
// GET — return conventions if saved, otherwise null (UI shows the wizard).
// ────────────────────────────────────────────────────────────────────────────

export async function GET(req: Request) {
  const session = await getSession();
  const url = new URL(req.url);
  const owner = url.searchParams.get("owner");
  const repo = url.searchParams.get("repo");
  if (!owner || !repo) return errorResponse("Missing ?owner=&repo=", 400);

  const key = repoKey(owner, repo);
  const conventions = session.repo_conventions?.[key] ?? null;
  return jsonResponse({ conventions, key });
}

// ────────────────────────────────────────────────────────────────────────────
// PUT — validate + persist. Body must include owner/repo.
// ────────────────────────────────────────────────────────────────────────────

const PutBodySchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  conventions: RepoConventionsSchema,
});

export async function PUT(req: Request) {
  const parsed = PutBodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return errorResponse("Invalid request body", 400, parsed.error.message);
  }
  const { owner, repo, conventions } = parsed.data;

  const session = await getSession();
  session.repo_conventions = session.repo_conventions ?? {};
  session.repo_conventions[repoKey(owner, repo)] = {
    ...conventions,
    saved_at: new Date().toISOString(),
  };
  await session.save();

  return jsonResponse({
    ok: true,
    key: repoKey(owner, repo),
    conventions: session.repo_conventions[repoKey(owner, repo)],
  });
}

// ────────────────────────────────────────────────────────────────────────────
// DELETE — clear conventions for a repo (used by "Edit conventions" → reset).
// ────────────────────────────────────────────────────────────────────────────

export async function DELETE(req: Request) {
  const url = new URL(req.url);
  const owner = url.searchParams.get("owner");
  const repo = url.searchParams.get("repo");
  if (!owner || !repo) return errorResponse("Missing ?owner=&repo=", 400);

  const session = await getSession();
  if (session.repo_conventions?.[repoKey(owner, repo)]) {
    delete session.repo_conventions[repoKey(owner, repo)];
    await session.save();
  }
  return jsonResponse({ ok: true });
}
