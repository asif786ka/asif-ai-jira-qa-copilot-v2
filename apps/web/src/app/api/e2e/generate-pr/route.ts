/**
 * POST /api/e2e/generate-pr
 *
 * The headline Phase 11 endpoint. Orchestrates the full flow:
 *
 *   1. Read saved RepoConventions for (main_owner, main_repo, platform)
 *   2. Generate the test code (Maestro YAML / XCUITest Swift / Espresso Kotlin)
 *      via /api/generate-code logic, using the smart-routed LLM
 *   3. Generate all the scaffolding files (Fastfile, Gemfile, CI workflows, README)
 *      via @jiraqa/core templates
 *   4. Ensure the e2e repo exists (create it if not)
 *   5. Create a feature branch jiraqa/<ticket-key>
 *   6. Commit each generated file onto the branch
 *   7. Open a PR with a meaningful title and body
 *
 * Request body:
 *   { ticket: JiraTicket, test_cases: TestCase[], main_owner: string, main_repo: string }
 *
 * Response:
 *   { pr_url: string, e2e_repo: string, branch: string, files_committed: number }
 */

import { z } from "zod";
import {
  JiraTicketSchema,
  TestCaseSchema,
  applyMarker,
  buildCodeGenSpec,
  generateAllScaffolding,
  parseMarker,
  type MarkerInfo,
  type RepoConventions,
} from "@jiraqa/core";
import {
  GitHubRestProvider,
  getLLMProvider,
  resolveLLMProvider,
} from "@jiraqa/providers";
import { errorResponse, jsonResponse } from "@/lib/utils";
import { getSession } from "@/lib/session";

export const runtime = "nodejs";
export const maxDuration = 90;

const Body = z.object({
  ticket: JiraTicketSchema,
  test_cases: z.array(TestCaseSchema).min(1).max(8),
  main_owner: z.string().min(1),
  main_repo: z.string().min(1),
});

export async function POST(req: Request) {
  // Top-level try/catch — ensures we ALWAYS return a JSON body so the client
  // never gets "Unexpected end of JSON input". Anything unhandled inside the
  // orchestration becomes a structured 500 with the error message attached.
  try {
    return await runGeneratePr(req);
  } catch (e) {
    console.error("[generate-pr] uncaught:", e);
    return errorResponse(
      `Unexpected failure: ${(e as Error).message}`,
      500,
      "Check the server console for the full stack trace.",
    );
  }
}

async function runGeneratePr(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return errorResponse("Invalid request body", 400, parsed.error.message);
  }
  const { ticket, test_cases, main_owner, main_repo } = parsed.data;

  // ── 1. Read session + conventions ──────────────────────────────────────
  const session = await getSession();
  if (!session.github?.pat) {
    return errorResponse("GitHub is not connected.", 400);
  }
  const key = `${main_owner}/${main_repo}`;
  const conventions: RepoConventions | undefined =
    session.repo_conventions?.[key];
  if (!conventions) {
    return errorResponse(
      "No E2E conventions saved for this repo. Open the Configure dialog first.",
      400,
    );
  }

  // ── 2. Generate the test code ──────────────────────────────────────────
  // Prefer the multi-agent /pyapi/agentic-e2e-codegen pipeline (scanner →
  // generator → static reviewer with bounded repair loop → PR narrator).
  // Fall back to the legacy single-LLM-call path if the agentic endpoint
  // is unreachable (e.g. running TS-only in prod, or the Python sidecar
  // is down).
  const spec = buildCodeGenSpec(ticket, test_cases, conventions);
  // Provider resolution order (most specific → least):
  //   1. session.preferred_provider — the value the user picked in the
  //      header toggle. Honour it so a "Switch to OpenAI" choice isn't
  //      silently overridden by per-framework smart routing (which used
  //      to send XCUITest to Gemini and hit 503s on outage days).
  //   2. spec.recommendedProvider — the per-framework default from
  //      buildCodeGenSpec (e.g. Gemini for XCUITest's longer context).
  //   3. resolveLLMProvider() — the global default from the registry.
  let llm;
  const preferredOrder: Array<string | undefined> = [
    session.preferred_provider,
    spec.recommendedProvider,
  ];
  for (const name of preferredOrder) {
    if (!name) continue;
    try {
      const candidate = getLLMProvider(name);
      if (candidate.isAvailable()) {
        llm = candidate;
        break;
      }
    } catch {
      // not registered — fall through
    }
  }
  if (!llm) {
    try {
      llm = resolveLLMProvider();
    } catch (e) {
      return errorResponse((e as Error).message, 500);
    }
  }

  type AgenticResult = {
    files: Array<{ path: string; content: string }>;
    pr_title: string;
    pr_description: string;
    repair_attempts: number;
    used_agentic: boolean;
  };

  const agentic = await tryAgenticCodegen({
    ticket,
    test_cases,
    platform: conventions.platform,
    framework: conventions.test_format,
    e2e_repo_name: conventions.e2e_repo_name ?? "",
    main_repo: `${main_owner}/${main_repo}`,
    provider: llm.name,
  });

  let codegen: AgenticResult;
  if (agentic) {
    codegen = { ...agentic, used_agentic: true };
  } else {
    // Legacy fallback — single LLM call producing one file at the
    // conventional destination path.
    let code: string;
    try {
      const completion = await llm.complete({
        systemPrompt: spec.systemPrompt,
        userPrompt: spec.userPrompt,
        temperature: 0.2,
        jsonMode: spec.jsonMode,
        maxTokens: 4000,
      });
      code = completion.text;
    } catch (e) {
      return errorResponse(`LLM code generation failed: ${(e as Error).message}`, 502);
    }
    if (!code || code.trim().length < 20) {
      return errorResponse("LLM returned empty code", 500);
    }
    codegen = {
      files: [{ path: spec.destinationPath, content: code }],
      pr_title: `[${ticket.ticket_id}] ${ticket.summary}`,
      pr_description: "",  // built below via the legacy template
      repair_attempts: 0,
      used_agentic: false,
    };
  }

  // ── 3. Generate scaffolding files ──────────────────────────────────────
  const scaffolding = generateAllScaffolding(conventions, {
    owner: main_owner,
    repo: main_repo,
  });

  // ── 4. Ensure the e2e repo exists ──────────────────────────────────────
  const gh = new GitHubRestProvider({ pat: session.github.pat });
  const ping = await gh.ping();
  if (!ping.ok) {
    return errorResponse(`GitHub auth failed: ${ping.error}`, 401);
  }
  const me = ping.login;

  const e2eRepoName =
    conventions.e2e_repo_name ?? `${main_repo}-${conventions.platform}-e2e`;
  const e2eOwner = me; // user's namespace by default
  const e2eFullName = `${e2eOwner}/${e2eRepoName}`;
  const existed = await gh.repoExists(e2eOwner, e2eRepoName);
  let createdNewRepo = false;
  if (!existed) {
    try {
      await gh.createRepo({
        name: e2eRepoName,
        description: `E2E ${conventions.platform.toUpperCase()} tests for ${main_owner}/${main_repo} — generated by jiraqa.com`,
        private: true,
      });
      createdNewRepo = true;
      // GitHub takes a brief moment to fully initialise auto_init'd repos.
      await new Promise((r) => setTimeout(r, 1500));
    } catch (e) {
      const msg = (e as Error).message;
      if (/403|forbidden|not accessible/i.test(msg)) {
        return errorResponse(
          `Cannot create the e2e repo automatically — your GitHub PAT is missing the "Administration: Read and write" scope.`,
          403,
          `Two options:\n  1. Update your PAT at https://github.com/settings/personal-access-tokens to include Administration: Read and write, then reconnect in the app.\n  2. OR create an empty repository named "${e2eRepoName}" on GitHub manually, then click "Generate E2E PR" again — we'll commit to it directly.`,
        );
      }
      return errorResponse(`GitHub createRepo failed: ${msg}`, 502);
    }
  }

  // ── 5. Create a feature branch ─────────────────────────────────────────
  const safeKey = ticket.ticket_id.replace(/[^A-Za-z0-9-]/g, "-").toLowerCase();
  const branchName = `jiraqa/${safeKey}`;
  const baseBranch = "main";
  try {
    const baseSha = await gh.getBranchSha(e2eOwner, e2eRepoName, baseBranch);
    try {
      await gh.createBranch(e2eOwner, e2eRepoName, branchName, baseSha);
    } catch (e) {
      // Branch may already exist — that's fine, we'll just commit onto it
      const msg = (e as Error).message;
      if (!msg.includes("Reference already exists")) {
        throw e;
      }
    }
  } catch (e) {
    const msg = (e as Error).message;
    if (/Resource not accessible by personal access token/i.test(msg)) {
      return errorResponse(
        `Your GitHub PAT can't access the new e2e repo "${e2eRepoName}".`,
        403,
        `Fine-grained PATs require BOTH permissions AND repository selection. Your PAT has the right permissions but the new e2e repo isn't in its allowlist.\n\nFix at https://github.com/settings/personal-access-tokens:\n  • Edit your token\n  • Under "Repository access", either pick "All repositories" OR click "Select repositories" and add "${e2eRepoName}" to the list\n  • Click Update — the token value stays the same\n  • Refresh this page and click Generate E2E PR again\n\nNo need to regenerate the token or re-paste it in Connections.`,
      );
    }
    if (/404|Not Found/i.test(msg) && /refs\/heads\/main/i.test(msg)) {
      return errorResponse(
        `The e2e repo exists but has no "main" branch yet.`,
        500,
        `Visit https://github.com/${e2eOwner}/${e2eRepoName} and ensure it has been initialized (has at least one commit on "main"). If you created it manually, make sure "Initialize with README" was checked.`,
      );
    }
    return errorResponse(`Could not create branch: ${msg}`, 500);
  }

  // ── 6. Capture source-repo HEAD SHA (Phase 13.2 Tier 1) ───────────────
  let mainHeadSha: string | undefined;
  try {
    mainHeadSha = await gh.getBranchSha(main_owner, main_repo, "main");
  } catch {
    // Some repos use "master" — try that as a fallback.
    try {
      mainHeadSha = await gh.getBranchSha(main_owner, main_repo, "master");
    } catch {
      // Not fatal — we still generate, just without staleness metadata.
    }
  }

  const markerInfo: MarkerInfo = {
    version: "v1",
    source_repo: `${main_owner}/${main_repo}`,
    source_sha: mainHeadSha,
    ticket_id: ticket.ticket_id,
    generated_at: new Date().toISOString(),
  };

  // ── 7. Commit each file with marker + conflict detection ──────────────
  // `codegen.files` is either the single legacy file at spec.destinationPath
  // OR the N files produced by the agentic pipeline.
  const filesToCommit = [
    ...scaffolding,
    ...codegen.files,
  ];

  // Files preserved as .v2 because the live version was hand-edited.
  const preservedAsV2: string[] = [];

  let committed = 0;
  let firstError: string | null = null;
  for (const f of filesToCommit) {
    try {
      // Apply our marker to the proposed content.
      const ourContent = applyMarker(f.content, f.path, markerInfo);

      // Check whether the branch already has this file, and if so whether
      // it still has our marker (meaning safe to overwrite) or has been
      // hand-edited (meaning preserve it).
      const existing = await gh.getFileContent({
        owner: e2eOwner,
        repo: e2eRepoName,
        branch: branchName,
        path: f.path,
      });

      let targetPath = f.path;
      if (existing !== null) {
        const existingMarker = parseMarker(existing);
        if (!existingMarker) {
          // No marker — assume hand-edited. Write to .v2 path next to it.
          targetPath = sideBySidePath(f.path);
          preservedAsV2.push(f.path);
        } else if (existing === ourContent) {
          // Identical — skip the commit (no-op).
          committed++;
          continue;
        }
        // else: our marker present + content differs → overwrite (regeneration)
      }

      await gh.putFile({
        owner: e2eOwner,
        repo: e2eRepoName,
        branch: branchName,
        path: targetPath,
        content: ourContent,
        message:
          targetPath === f.path
            ? `${ticket.ticket_id}: update ${targetPath}`
            : `${ticket.ticket_id}: add ${targetPath} (preserved hand-edited ${f.path})`,
      });
      committed++;
    } catch (e) {
      const msg = (e as Error).message;
      if (!firstError) firstError = msg;
      console.error(`Failed to commit ${f.path}:`, msg);
    }
  }

  if (committed === 0) {
    if (firstError && /Resource not accessible by personal access token/i.test(firstError)) {
      return errorResponse(
        `Your GitHub PAT can't commit to "${e2eRepoName}".`,
        403,
        `Add this repo to your PAT's allowlist at https://github.com/settings/personal-access-tokens → Edit → Repository access → either "All repositories" or add "${e2eRepoName}" to the selected list. Then refresh and try again.`,
      );
    }
    return errorResponse(
      "Failed to commit any files to the e2e repo",
      500,
      firstError ?? "Check the GitHub PAT has Contents: Read and write on the e2e repo.",
    );
  }

  // ── 8. Open PR ─────────────────────────────────────────────────────────
  // Prefer the agent-written PR description when available — it maps each
  // test to its acceptance criteria and quotes the followed conventions.
  // Fall back to the deterministic template for the legacy single-call path.
  const legacyHeader = [
    `### Auto-generated by [jiraqa.com](https://jiraqa.com)`,
    ``,
    `**Jira ticket**: [${ticket.ticket_id}] ${ticket.summary}`,
    `**Platform**: ${conventions.platform}`,
    `**Test format**: ${conventions.test_format}`,
    `**LLM used**: ${llm.name} / ${llm.defaultModel}`,
    `**Pipeline**: ${codegen.used_agentic ? `multi-agent (LangGraph, ${codegen.repair_attempts} repair${codegen.repair_attempts === 1 ? "" : "s"})` : "single-shot LLM"}`,
    `**Source**: \`${main_owner}/${main_repo}${mainHeadSha ? `@${mainHeadSha.slice(0, 7)}` : ""}\``,
    ``,
    `### Test scenarios`,
    ...test_cases.map(
      (tc) => `- **${tc.test_case_id}** — ${tc.test_scenario}`,
    ),
    ``,
  ];
  const prBody = [
    ...legacyHeader,
    ...(codegen.used_agentic && codegen.pr_description
      ? [`### Reviewer notes (agentic)`, codegen.pr_description, ``]
      : []),
    ...(preservedAsV2.length > 0
      ? [
          `### ⚠ Hand-edited files preserved`,
          `The following files were hand-edited since we last generated. We did NOT overwrite them — the new versions are committed alongside as \`.v2\`:`,
          ...preservedAsV2.map((p) => `- \`${p}\` → \`${sideBySidePath(p)}\``),
          ``,
          `Review both, merge the edits you want to keep, and delete the \`.v2\` files.`,
          ``,
        ]
      : []),
    ...(createdNewRepo
      ? [
          `### First-run setup`,
          `This is the bootstrap PR for your E2E suite. After merge:`,
          `1. \`bundle install\` to fetch Fastlane.`,
          conventions.test_format === "maestro"
            ? `2. \`curl -Ls "https://get.maestro.mobile.dev" | bash\` to install Maestro.`
            : `2. Open the project in Xcode / Android Studio and resolve any signing.`,
          `3. Run \`bundle exec fastlane ${conventions.platform === "ios" ? "ios" : "android"} e2e\` to verify locally.`,
        ]
      : []),
    ``,
    `### How to revert`,
    `This PR only touches the \`${e2eRepoName}\` repo. Your main app at \`${main_owner}/${main_repo}\` is unchanged. Revert this PR to remove all generated files.`,
  ].join("\n");

  let pr: { html_url: string; number: number };
  let prAlreadyExisted = false;
  try {
    pr = await gh.openPullRequest({
      owner: e2eOwner,
      repo: e2eRepoName,
      // Use the agent-narrated title when available, capped at 72 chars for
      // GitHub's PR list UI. Falls back to the simple template otherwise.
      title:
        codegen.used_agentic && codegen.pr_title
          ? codegen.pr_title.slice(0, 72)
          : `[${ticket.ticket_id}] ${ticket.summary}`,
      body: prBody,
      head: branchName,
      base: baseBranch,
    });
  } catch (e) {
    const msg = (e as Error).message;
    // 422 + "already exists" → look up the existing PR and return it.
    if (/422/.test(msg) && /pull request already exists/i.test(msg)) {
      const existing = await gh.findOpenPullRequest({
        owner: e2eOwner,
        repo: e2eRepoName,
        head: branchName,
      });
      if (existing) {
        pr = existing;
        prAlreadyExisted = true;
      } else {
        return errorResponse(
          `A PR already exists for branch "${branchName}" but I couldn't fetch its URL. Look on GitHub directly: https://github.com/${e2eOwner}/${e2eRepoName}/pulls`,
          500,
        );
      }
    } else {
      return errorResponse(`Could not open PR: ${msg}`, 500);
    }
  }

  return jsonResponse({
    pr_url: pr.html_url,
    pr_number: pr.number,
    e2e_repo: e2eFullName,
    branch: branchName,
    files_committed: committed,
    created_new_repo: createdNewRepo,
    pr_already_existed: prAlreadyExisted,
    preserved_as_v2: preservedAsV2,
    source_sha: mainHeadSha ?? null,
    provider_used: llm.name,
    model_used: llm.defaultModel,
    used_agentic: codegen.used_agentic,
    repair_attempts: codegen.repair_attempts,
  });
}

/**
 * Try the multi-agent codegen pipeline. Returns `null` on any failure so
 * the caller can fall back to the single-LLM-call path.
 *
 * In local dev we hit FastAPI directly on :5001 to bypass the Next.js dev
 * rewrite (which aborts long requests with ECONNRESET). In production
 * (Vercel) the same-origin /pyapi/... path is rewritten to the Python
 * function by vercel.json.
 */
async function tryAgenticCodegen(input: {
  ticket: unknown;
  test_cases: unknown;
  platform: string;
  framework: string;
  e2e_repo_name: string;
  main_repo: string;
  provider: string | null;
}): Promise<{
  files: Array<{ path: string; content: string }>;
  pr_title: string;
  pr_description: string;
  repair_attempts: number;
} | null> {
  const supported = new Set(["maestro", "xcuitest", "espresso", "playwright"]);
  if (!supported.has(input.framework)) return null;

  const url =
    process.env.NODE_ENV !== "production"
      ? "http://localhost:5001/pyapi/agentic-e2e-codegen"
      : "/pyapi/agentic-e2e-codegen";

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
      // 90s upper bound — the pipeline runs 3-4 sequential LLM calls.
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) {
      console.warn(
        `[generate-pr] agentic-e2e-codegen returned ${res.status}; falling back to single-shot`,
      );
      return null;
    }
    const data = (await res.json()) as {
      ok?: boolean;
      files?: Array<{ path: string; content: string }>;
      pr_title?: string;
      pr_description?: string;
      repair_attempts?: number;
    };
    if (!data?.ok || !Array.isArray(data.files) || data.files.length === 0) {
      console.warn(
        "[generate-pr] agentic-e2e-codegen returned no files; falling back",
      );
      return null;
    }
    return {
      files: data.files,
      pr_title: data.pr_title ?? "",
      pr_description: data.pr_description ?? "",
      repair_attempts: data.repair_attempts ?? 0,
    };
  } catch (e) {
    console.warn(
      `[generate-pr] agentic-e2e-codegen unreachable (${(e as Error).message}); falling back`,
    );
    return null;
  }
}

/**
 * Turn "e2e/flows/CUSTOM-foo.yaml" into "e2e/flows/CUSTOM-foo.v2.yaml" —
 * keeps the extension at the end so editor tooling still recognises the
 * format.
 */
function sideBySidePath(path: string): string {
  const lastDot = path.lastIndexOf(".");
  if (lastDot < 0) return `${path}.v2`;
  return `${path.slice(0, lastDot)}.v2${path.slice(lastDot)}`;
}
