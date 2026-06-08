"use client";

import { useEffect, useMemo, useState } from "react";
import type {
  JiraTicket,
  Platform,
  QualityScore,
  RepoContext,
  RepoConventions,
  Screenshot,
  TestCase,
  TicketValidationIssue,
  TicketValidationResult,
} from "@jiraqa/core";
import { validateTicketRulesOnly } from "@jiraqa/core";
import {
  Loader2,
  Smartphone,
  Apple,
  Globe,
  AlertTriangle,
  Settings2,
  FileText,
  Sparkles,
} from "lucide-react";
import { TestCaseCard } from "./TestCaseCard";
import { getActiveBackend } from "./BackendSwitcher";
import { ConventionsWizard } from "./ConventionsWizard";
import {
  CustomScenarioForm,
  type CustomScenarioOutput,
} from "./CustomScenarioForm";
import { QualityBadge } from "./QualityBadge";
import { SavedTestsPanel } from "./SavedTestsPanel";
import { TicketValidationPanel } from "./TicketValidationPanel";

type SessionView = {
  jira: { site_url: string; email: string; connected: true } | null;
  github: { login: string | null; connected: true } | null;
};

type JiraProject = { id: string; key: string; name: string };
type JiraIssueSummary = { key: string; summary: string; issue_type: string; status: string };
type GitHubRepoSummary = {
  full_name: string;
  owner: string;
  name: string;
  default_branch: string;
  private: boolean;
};

export function Wizard() {
  const [session, setSession] = useState<SessionView | null>(null);
  const [projects, setProjects] = useState<JiraProject[]>([]);
  const [projectKey, setProjectKey] = useState<string>("");
  const [issues, setIssues] = useState<JiraIssueSummary[]>([]);
  const [issueKey, setIssueKey] = useState<string>("");
  const [ticket, setTicket] = useState<JiraTicket | null>(null);
  const [repos, setRepos] = useState<GitHubRepoSummary[]>([]);
  const [repoFullName, setRepoFullName] = useState<string>("");
  const [repoContext, setRepoContext] = useState<RepoContext | null>(null);
  const [platform, setPlatform] = useState<Platform>("web");
  const [generating, setGenerating] = useState(false);
  const [results, setResults] = useState<TestCase[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [providerUsed, setProviderUsed] = useState<string>("");
  const [backendUsed, setBackendUsed] = useState<string>("");

  // Phase 11 — per-repo conventions
  const [conventions, setConventions] = useState<RepoConventions | null>(null);
  const [conventionsWizardOpen, setConventionsWizardOpen] = useState(false);

  // Phase 12 — source toggle: Jira ticket vs custom scenario
  const [source, setSource] = useState<"jira" | "custom">("jira");
  const [customOutput, setCustomOutput] = useState<CustomScenarioOutput | null>(
    null,
  );

  // QA-readiness validation. Whenever the active ticket changes, we POST it
  // to /api/validate-ticket and gate the Generate button on result.passed.
  // The server-side rules check is the source of truth; this is the friendly
  // UX layer that surfaces issues before the user clicks Generate.
  const [validation, setValidation] = useState<TicketValidationResult | null>(
    null,
  );
  const [validating, setValidating] = useState(false);

  // Layer 1+2 — output quality artifacts attached to a successful generation.
  // `quality` is the judge verdict (LLM-as-judge); `lintWarnings` are the
  // non-blocking issues from the deterministic linter (e.g. missing edge tag).
  const [quality, setQuality] = useState<QualityScore | null>(null);
  const [lintWarnings, setLintWarnings] = useState<TicketValidationIssue[]>([]);

  // Streaming progress — populated by SSE events from
  // /pyapi/agentic-generate-stream. Empty when running the TS single-shot path.
  const [progress, setProgress] = useState<{
    pct: number;
    stage: string;
    message: string;
    repairAttempts?: number;
  } | null>(null);
  // When custom is active, override ticket + platform + screenshots from the form.
  const activeTicket: JiraTicket | null =
    source === "custom" ? customOutput?.ticket ?? null : ticket;
  const activePlatform: Platform =
    source === "custom" ? customOutput?.platform ?? platform : platform;
  const activeScreenshots: Screenshot[] | undefined =
    source === "custom" ? customOutput?.screenshots : undefined;

  // Phase 11.7 — E2E PR flow state
  const [creatingPr, setCreatingPr] = useState(false);
  const [prResult, setPrResult] = useState<{
    pr_url: string;
    e2e_repo: string;
    branch: string;
    files_committed: number;
    created_new_repo: boolean;
    pr_already_existed?: boolean;
    provider_used: string;
  } | null>(null);
  const [prError, setPrError] = useState<string | null>(null);

  // ── Load session ────────────────────────────────────────────────────────
  useEffect(() => {
    fetch("/api/connections/save")
      .then((r) => r.json())
      .then((d) => setSession(d.session))
      .catch(() => {});
  }, []);

  // ── Load Jira projects + GitHub repos once connected ────────────────────
  useEffect(() => {
    if (!session?.jira) return;
    fetch("/api/jira/projects")
      .then((r) => r.json())
      .then((d) => setProjects(d.projects ?? []))
      .catch(() => {});
  }, [session]);

  useEffect(() => {
    if (!session?.github) return;
    fetch("/api/github/repos?limit=50")
      .then((r) => r.json())
      .then((d) => setRepos(d.repos ?? []))
      .catch(() => {});
  }, [session]);

  // ── Load issues when a project is picked ────────────────────────────────
  const [issuesError, setIssuesError] = useState<string | null>(null);
  useEffect(() => {
    if (!projectKey) return;
    setIssuesError(null);
    fetch(`/api/jira/issues?project=${encodeURIComponent(projectKey)}&limit=25`)
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) {
          setIssuesError(d.error ?? `HTTP ${r.status}`);
          setIssues([]);
          return;
        }
        if (!d.issues || d.issues.length === 0) {
          setIssuesError("No issues found for this project.");
        }
        setIssues(d.issues ?? []);
      })
      .catch((e) => {
        setIssuesError((e as Error).message);
        setIssues([]);
      });
  }, [projectKey]);

  // ── Load full ticket when one is picked ─────────────────────────────────
  useEffect(() => {
    if (!issueKey) {
      setTicket(null);
      return;
    }
    fetch(`/api/jira/issue?key=${encodeURIComponent(issueKey)}`)
      .then((r) => r.json())
      .then((d) => setTicket(d.ticket ?? null))
      .catch(() => {});
  }, [issueKey]);

  // ── Load repo context when a repo is picked ─────────────────────────────
  useEffect(() => {
    if (!repoFullName) {
      setRepoContext(null);
      return;
    }
    const [owner, repo] = repoFullName.split("/");
    if (!owner || !repo) return;
    fetch(`/api/github/context?owner=${owner}&repo=${repo}`)
      .then((r) => r.json())
      .then((d) => {
        setRepoContext(d.context ?? null);
        if (d.context?.detected_platforms?.length === 1) {
          setPlatform(d.context.detected_platforms[0] as Platform);
        }
      })
      .catch(() => {});
  }, [repoFullName]);

  // ── Load saved E2E conventions when repo or platform changes ────────────
  useEffect(() => {
    if (!repoFullName) {
      setConventions(null);
      return;
    }
    const [owner, repo] = repoFullName.split("/");
    if (!owner || !repo) return;
    fetch(
      `/api/conventions?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}`,
    )
      .then((r) => r.json())
      .then((d) => {
        const c: RepoConventions | null = d.conventions;
        // Only count conventions valid for the currently-picked platform.
        if (c && c.platform === platform) {
          setConventions(c);
        } else {
          setConventions(null);
        }
      })
      .catch(() => setConventions(null));
  }, [repoFullName, platform]);

  // ── Three-tier validation ───────────────────────────────────────────────
  // Tier 1 (instant, client-side, zero network): deterministic rules from
  //         @jiraqa/core run on every change of the active ticket via a
  //         pure `useMemo`. Same rules as the server — single source of
  //         truth lives in packages/core/src/validation.ts.
  // Tier 2 (opt-in, server, deterministic): the user can request a server
  //         re-check via the "Check on server" button below. Useful when a
  //         dev is iterating on the rule set and wants to confirm parity.
  // Tier 3 (on Generate click): the LLM rubric. Runs as part of the
  //         /agentic-generate readiness agent, never on edit. Zero LLM
  //         cost while the user is still filling the form.
  //
  // Removing the on-edit /api/validate-ticket round-trip cuts ~5–8 network
  // calls per ticket and eliminates server load proportional to typing speed.
  useEffect(() => {
    // Drop the server-fetched verdict on every ticket change — a stale
    // server "passed" must never mask a fresh local failure.
    setValidation(null);
    setValidating(false);
  }, [activeTicket]);

  const liveValidation = useMemo<TicketValidationResult | null>(() => {
    if (!activeTicket) return null;
    return validateTicketRulesOnly(activeTicket);
  }, [activeTicket]);

  // The visible validation prefers the latest server result (if the user
  // explicitly ran one), otherwise the local result. They are produced by
  // the same rule set so divergence should be impossible — the precedence
  // only matters when the server response also carries a rubric verdict.
  const effectiveValidation: TicketValidationResult | null =
    validation ?? liveValidation;

  // ── Optional server re-check (Tier 2, opt-in) ───────────────────────────
  async function recheckOnServer(opts: { withRubric: boolean }) {
    if (!activeTicket) return;
    setValidating(true);
    try {
      const res = await fetch("/api/validate-ticket", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ticket: activeTicket,
          platform: activePlatform,
          use_llm_rubric: opts.withRubric,
        }),
      });
      const data = (await res.json()) as TicketValidationResult & {
        error?: string;
      };
      if (data && typeof data.passed === "boolean") {
        setValidation(data);
      }
    } catch {
      // Network blip — leave the last known result so we don't flap.
    } finally {
      setValidating(false);
    }
  }

  // ── Generate ────────────────────────────────────────────────────────────
  async function generate() {
    if (!activeTicket) return;
    // Hard block at the UI layer too. The server still gates with 422,
    // but no point firing a request we know will be rejected. Use the
    // effective validation (server result if available, else local rules).
    if (effectiveValidation && !effectiveValidation.passed) {
      setError("Ticket failed QA-readiness checks — fix the issues listed above.");
      return;
    }
    setGenerating(true);
    setError(null);
    setResults(null);
    setProviderUsed("");
    setBackendUsed("");
    setQuality(null);
    setLintWarnings([]);
    setProgress(null);
    try {
      const backend = getActiveBackend();
      // TypeScript backend → single-shot /api/generate (JSON).
      // Python backend → /pyapi/agentic-generate-stream (server-sent events)
      // so the UI shows a real progress bar driven by LangGraph's astream.
      //
      // In LOCAL DEV we bypass the Next.js rewrite for the Python backend
      // and call FastAPI directly on :5001. The dev proxy aborts long-
      // running requests with ECONNRESET. Same-origin in production.
      const isDev =
        typeof process !== "undefined" &&
        process.env.NODE_ENV !== "production";
      const pythonStreamUrl = isDev
        ? "http://localhost:5001/pyapi/agentic-generate-stream"
        : "/pyapi/agentic-generate-stream";

      const requestBody = JSON.stringify({
        ticket: activeTicket,
        platform: activePlatform,
        repo_context: repoContext ?? undefined,
        count_hint: 5,
        screenshots: activeScreenshots,
        judge: true,
      });

      // ── Python path: parse SSE events into progress + final result ───
      if (backend === "python") {
        const sseRes = await fetch(pythonStreamUrl, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "text/event-stream" },
          body: requestBody,
        });
        if (!sseRes.ok || !sseRes.body) {
          throw new Error(`Stream request failed (HTTP ${sseRes.status})`);
        }
        const reader = sseRes.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let final: Record<string, unknown> | null = null;

        outer: while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          // SSE frames are separated by a blank line.
          let idx;
          while ((idx = buffer.indexOf("\n\n")) !== -1) {
            const frame = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            let event = "message";
            let dataStr = "";
            for (const line of frame.split("\n")) {
              if (line.startsWith("event:")) event = line.slice(6).trim();
              else if (line.startsWith("data:")) dataStr += line.slice(5).trim();
            }
            if (!dataStr) continue;
            let payload: Record<string, unknown>;
            try {
              payload = JSON.parse(dataStr);
            } catch {
              continue;
            }
            if (event === "progress") {
              setProgress({
                pct: Number(payload.pct ?? 0),
                stage: String(payload.stage ?? ""),
                message: String(payload.message ?? ""),
                repairAttempts:
                  typeof payload.repair_attempts === "number"
                    ? payload.repair_attempts
                    : undefined,
              });
            } else if (event === "result") {
              final = payload;
              break outer;
            }
          }
        }

        if (!final) throw new Error("Stream ended without a final result");
        // Map the streamed result the same way as the JSON path below.
        const data = final as Record<string, unknown>;
        if (data.code === "ticket_validation_failed" && data.validation) {
          setValidation(data.validation as TicketValidationResult);
          throw new Error((data.error as string) ?? "Ticket failed validation");
        }
        if (data.error) {
          throw new Error(String(data.error));
        }
        setResults((data.generated_test_cases as TestCase[]) ?? []);
        setProviderUsed((data.provider as string) ?? "");
        setBackendUsed((data.backend as string) ?? backend);
        if (data.quality) setQuality(data.quality as QualityScore);
        if (Array.isArray(data.lint_warnings)) {
          setLintWarnings(data.lint_warnings as TicketValidationIssue[]);
        }
        return;
      }

      // ── TypeScript path: original single-shot JSON request ───────────
      const endpoint = "/api/generate";
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: requestBody,
      });
      const data = await res.json();
      if (!res.ok) {
        // Two flavours of 422 the server can return:
        //   - ticket_validation_failed: bad INPUT, rendered via TicketValidationPanel.
        //   - output_validation_failed: bad OUTPUT (LLM produced unusable test
        //     cases) — surface in the lint-warnings panel and offer regenerate.
        if (
          res.status === 422 &&
          data?.code === "ticket_validation_failed" &&
          data?.validation
        ) {
          setValidation(data.validation as TicketValidationResult);
          throw new Error(data.error ?? "Ticket failed validation");
        }
        if (
          res.status === 422 &&
          data?.code === "output_validation_failed" &&
          data?.validation
        ) {
          setLintWarnings(
            (data.validation.issues ?? []) as TicketValidationIssue[],
          );
          // Suppress the generic error string — the detail panel below the
          // Generate button renders the issue list and a regenerate button.
          // Throwing here just stops the success path from running.
          throw new Error("");
        }
        throw new Error(data.error ?? "Generation failed");
      }
      setResults(data.generated_test_cases ?? []);
      setProviderUsed(data.provider ?? "");
      setBackendUsed(data.backend ?? backend);
      // Side-channel fields the generator attaches when present.
      if (data.quality) setQuality(data.quality as QualityScore);
      if (Array.isArray(data.lint_warnings)) {
        setLintWarnings(data.lint_warnings as TicketValidationIssue[]);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setGenerating(false);
      setProgress(null);
    }
  }

  // ── Phase 11.7 — Create the E2E PR ──────────────────────────────────────
  async function createE2EPr() {
    // Use the ACTIVE ticket — works for both the Jira and Custom-scenario
    // sources. Previously this only saw the Jira-flow `ticket` state, so
    // clicking "Generate E2E PR" from a Custom-scenario run was a silent no-op.
    if (!activeTicket || !results || !repoFullName) {
      setPrError(
        "Cannot create PR — need a ticket, generated test cases, and a selected GitHub repo.",
      );
      return;
    }
    const [owner, repo] = repoFullName.split("/");
    if (!owner || !repo) {
      setPrError(`Could not parse repo owner/name from "${repoFullName}".`);
      return;
    }
    setCreatingPr(true);
    setPrError(null);
    setPrResult(null);
    try {
      const res = await fetch("/api/e2e/generate-pr", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ticket: activeTicket,
          test_cases: results,
          main_owner: owner,
          main_repo: repo,
        }),
      });
      // Read body as text first — handles empty-body crash responses cleanly.
      const text = await res.text();
      let data: { error?: string; details?: string } & Record<string, unknown> = {};
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          throw new Error(
            `Server returned non-JSON response (HTTP ${res.status}). First 300 chars: ${text.slice(0, 300)}`,
          );
        }
      }
      if (!res.ok) {
        const detail = data.details ? `\n\n${data.details}` : "";
        throw new Error(`${data.error ?? `HTTP ${res.status}`}${detail}`);
      }
      setPrResult(
        data as {
          pr_url: string;
          e2e_repo: string;
          branch: string;
          files_committed: number;
          created_new_repo: boolean;
          provider_used: string;
        },
      );
    } catch (e) {
      setPrError((e as Error).message);
    } finally {
      setCreatingPr(false);
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────
  if (!session) {
    return (
      <div className="card text-center text-sm text-gray-400">
        <Loader2 className="w-4 h-4 animate-spin inline mr-2" />
        Loading session...
      </div>
    );
  }

  if (!session.jira || !session.github) {
    return (
      <div className="card text-center">
        <AlertTriangle className="w-6 h-6 text-yellow-400 mx-auto mb-2" />
        <p className="text-sm text-gray-300">
          Connect both <strong>Jira</strong> and <strong>GitHub</strong> first to start generating.
        </p>
        <a href="/connections" className="btn-primary mt-3 inline-flex">
          Go to Connections
        </a>
      </div>
    );
  }

  return (
    <section className="grid lg:grid-cols-12 gap-5">
      {/* Source toggle — full width above all three columns */}
      <div className="lg:col-span-12">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-gray-400">Test source:</span>
          <button
            onClick={() => setSource("jira")}
            className={`text-xs px-3 py-1.5 rounded-lg border flex items-center gap-1.5 ${
              source === "jira"
                ? "border-accent bg-accent/10 text-accent"
                : "border-border bg-bg-panel hover:bg-white/5 text-gray-300"
            }`}
          >
            <FileText className="w-3.5 h-3.5" /> Jira ticket
          </button>
          <button
            onClick={() => setSource("custom")}
            className={`text-xs px-3 py-1.5 rounded-lg border flex items-center gap-1.5 ${
              source === "custom"
                ? "border-accent bg-accent/10 text-accent"
                : "border-border bg-bg-panel hover:bg-white/5 text-gray-300"
            }`}
          >
            <Sparkles className="w-3.5 h-3.5" /> Custom scenario
          </button>
        </div>
      </div>

      {/* Left: Jira ticket picker OR custom scenario form */}
      <div className="lg:col-span-4 space-y-3">
        <h2 className="text-sm font-semibold text-gray-300">
          1. {source === "jira" ? "Jira ticket" : "Custom scenario"}
        </h2>
        {source === "custom" ? (
          <CustomScenarioForm onChange={setCustomOutput} />
        ) : (
        <div className="card space-y-3">
          <div>
            <label className="text-xs text-gray-400">Project</label>
            <select
              className="input mt-1"
              value={projectKey}
              onChange={(e) => setProjectKey(e.target.value)}
            >
              <option value="">— select project —</option>
              {projects.map((p) => (
                <option key={p.key} value={p.key}>
                  [{p.key}] {p.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs text-gray-400">Issue</label>
            <select
              className="input mt-1"
              value={issueKey}
              onChange={(e) => setIssueKey(e.target.value)}
              disabled={!projectKey}
            >
              <option value="">— select issue —</option>
              {issues.map((i) => (
                <option key={i.key} value={i.key}>
                  [{i.key}] {i.summary.slice(0, 60)}
                </option>
              ))}
            </select>
            {issuesError && (
              <div className="mt-2 text-[11px] text-red-400 border border-red-500/30 bg-red-500/10 rounded p-2 leading-snug">
                {issuesError}
              </div>
            )}
          </div>
          {ticket && (
            <div className="text-xs space-y-1 border-t border-border pt-3">
              <div className="text-gray-400">Preview</div>
              <div className="font-medium">{ticket.summary}</div>
              <div className="text-gray-500 line-clamp-3">{ticket.description}</div>
              {ticket.acceptance_criteria && ticket.acceptance_criteria.length > 0 && (
                <div className="text-gray-500">
                  <span className="text-gray-400">AC:</span>{" "}
                  {ticket.acceptance_criteria.length} criterion
                  {ticket.acceptance_criteria.length === 1 ? "" : "a"}
                </div>
              )}
            </div>
          )}
        </div>
        )}
      </div>

      {/* Middle: GitHub repo + platform */}
      <div className="lg:col-span-4 space-y-3">
        <h2 className="text-sm font-semibold text-gray-300">2. GitHub repo & platform</h2>
        <div className="card space-y-3">
          <div>
            <label className="text-xs text-gray-400">Repository</label>
            <select
              className="input mt-1"
              value={repoFullName}
              onChange={(e) => setRepoFullName(e.target.value)}
            >
              <option value="">— select repository —</option>
              {repos.map((r) => (
                <option key={r.full_name} value={r.full_name}>
                  {r.full_name}
                  {r.private ? " (private)" : ""}
                </option>
              ))}
            </select>
          </div>
          {repoContext && (
            <div className="text-xs space-y-1 border-t border-border pt-3">
              <div className="text-gray-400">Detected platforms</div>
              <div className="flex flex-wrap gap-1">
                {(repoContext.detected_platforms.length
                  ? repoContext.detected_platforms
                  : ["(none)"]
                ).map((p) => (
                  <span key={p} className="pill">
                    {p}
                  </span>
                ))}
              </div>
              <div className="text-gray-500 pt-1">
                {repoContext.file_tree_sample?.length ?? 0} tree entries ·{" "}
                {repoContext.key_files?.length ?? 0} key files
              </div>
            </div>
          )}
          <div>
            <label className="text-xs text-gray-400">Target platform</label>
            <div className="grid grid-cols-3 gap-2 mt-1">
              <PlatformPick value="android" current={platform} onPick={setPlatform} icon={<Smartphone className="w-4 h-4" />} />
              <PlatformPick value="ios" current={platform} onPick={setPlatform} icon={<Apple className="w-4 h-4" />} />
              <PlatformPick value="web" current={platform} onPick={setPlatform} icon={<Globe className="w-4 h-4" />} />
            </div>
          </div>

          {/* Phase 11: E2E conventions status / configure */}
          {repoFullName && (platform === "ios" || platform === "android") && (
            <div className="border-t border-border pt-3">
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs">
                  <div className="text-gray-400 mb-0.5">E2E test conventions</div>
                  {conventions ? (
                    <div className="text-gray-300">
                      <span className="pill bg-accent/10 border-accent/40 text-accent">
                        {conventions.test_format}
                      </span>{" "}
                      <span className="pill">{conventions.ci_platform}</span>{" "}
                      <span className="pill">{conventions.execution_backend}</span>
                    </div>
                  ) : (
                    <div className="text-gray-500 italic">not configured</div>
                  )}
                </div>
                <button
                  onClick={() => setConventionsWizardOpen(true)}
                  className="btn-ghost text-xs"
                >
                  <Settings2 className="w-3.5 h-3.5" />
                  {conventions ? "Edit" : "Configure"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Conventions wizard modal */}
      {conventionsWizardOpen && repoFullName && (
        <ConventionsWizard
          owner={repoFullName.split("/")[0] ?? ""}
          repo={repoFullName.split("/")[1] ?? ""}
          platform={platform}
          onSaved={(c) => {
            setConventions(c);
            setConventionsWizardOpen(false);
          }}
          onClose={() => setConventionsWizardOpen(false)}
        />
      )}

      {/* Right: Generate */}
      <div className="lg:col-span-4 space-y-3">
        <h2 className="text-sm font-semibold text-gray-300">3. Generate</h2>
        <div className="card space-y-3">
          {/* QA-readiness panel — runs the deterministic rules instantly
              on the client (Tier 1). No network call on edits. Server
              re-check is a button below, LLM rubric runs only on Generate. */}
          {activeTicket && (
            <TicketValidationPanel
              result={effectiveValidation}
              loading={validating}
            />
          )}
          {activeTicket && (
            <div className="flex gap-2 text-xs">
              <button
                type="button"
                className="btn-secondary flex-1"
                onClick={() => recheckOnServer({ withRubric: false })}
                disabled={validating}
                title="Re-run the same deterministic rules on the server. Free, ~10 ms."
              >
                {validating ? "Checking..." : "Check on server"}
              </button>
              <button
                type="button"
                className="btn-secondary flex-1"
                onClick={() => recheckOnServer({ withRubric: true })}
                disabled={validating}
                title="Run the LLM rubric for a semantic 'is this testable?' score. Costs one LLM call."
              >
                {validating ? "Scoring..." : "Run AI rubric"}
              </button>
            </div>
          )}
          <button
            className="btn-primary w-full"
            onClick={generate}
            disabled={
              !activeTicket ||
              generating ||
              validating ||
              (effectiveValidation !== null && !effectiveValidation.passed)
            }
          >
            {generating ? (
              <span className="flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" />
                {progress
                  ? `${progress.message}… ${progress.pct}%`
                  : "Generating…"}
              </span>
            ) : effectiveValidation && !effectiveValidation.passed ? (
              "Fix ticket to generate"
            ) : (
              "Generate test cases"
            )}
          </button>
          {/* Real progress bar driven by LangGraph astream events. Only
              renders for the Python multi-agent backend; the TS single-shot
              path leaves `progress` null. */}
          {generating && progress && (
            <div className="space-y-1">
              <div className="h-1.5 w-full rounded bg-white/5 overflow-hidden">
                <div
                  className="h-full bg-accent transition-[width] duration-300 ease-out"
                  style={{ width: `${Math.max(2, Math.min(100, progress.pct))}%` }}
                />
              </div>
              <div className="flex items-center justify-between text-[11px] text-gray-400">
                <span className="font-mono">
                  {progress.stage}
                  {progress.repairAttempts && progress.repairAttempts > 0
                    ? ` · repair ${progress.repairAttempts}`
                    : ""}
                </span>
                <span>{progress.pct}%</span>
              </div>
            </div>
          )}
          {error && error.trim() !== "" && (
            <div className="text-xs text-red-400 border border-red-500/30 bg-red-500/10 rounded-lg p-3">
              {error}
            </div>
          )}
          {/* Layer 1 — output-lint rejection detail.
              When the 422 "output_validation_failed" path fires, lintWarnings
              holds the error-severity issues. We render them here so the user
              sees exactly WHICH rules the LLM tripped (vague expected_result,
              non-atomic step, missing negative coverage, etc.) and can hit
              "Generate again" — LLM output is non-deterministic so a fresh
              roll often passes. */}
          {(() => {
            const lintErrors = lintWarnings.filter((i) => i.severity === "error");
            if (lintErrors.length === 0 || (results && results.length > 0)) return null;
            return (
              <div className="rounded-lg border border-red-700/50 bg-red-900/15 p-3 text-xs space-y-2">
                <div className="text-red-300 font-medium">
                  LLM output failed {lintErrors.length} quality check
                  {lintErrors.length === 1 ? "" : "s"}
                </div>
                <ul className="space-y-1.5 pl-3 list-disc marker:text-red-500 text-red-100/90">
                  {lintErrors.slice(0, 5).map((w, i) => (
                    <li key={`${w.code}-${i}`}>
                      <div>{w.message}</div>
                      {w.hint && (
                        <div className="text-red-300/70 text-[11px] mt-0.5">
                          Hint: {w.hint}
                        </div>
                      )}
                      <div className="text-red-400/40 font-mono text-[10px]">
                        {w.code}
                      </div>
                    </li>
                  ))}
                  {lintErrors.length > 5 && (
                    <li className="opacity-60">
                      …and {lintErrors.length - 5} more.
                    </li>
                  )}
                </ul>
                <button
                  className="btn-ghost w-full text-xs mt-1"
                  onClick={generate}
                  disabled={generating}
                >
                  {generating ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" /> Generating…
                    </>
                  ) : (
                    "Generate again"
                  )}
                </button>
                <div className="text-red-300/60 text-[11px] leading-relaxed">
                  Tip: LLM output is non-deterministic — a second attempt often
                  passes. If it keeps failing, try a different provider via the
                  Gemini / OpenAI toggle in the header.
                </div>
              </div>
            );
          })()}
          {providerUsed && (
            <div className="text-[11px] text-gray-500">
              Used <span className="text-accent">{providerUsed}</span> on{" "}
              <span className="text-accent">{backendUsed}</span> backend.
            </div>
          )}
        </div>
      </div>

      {/* Results */}
      {results && results.length > 0 && (
        <div className="lg:col-span-12 space-y-3">
          {/* Layer 2 — LLM-as-judge quality verdict and Layer 1 — deterministic
              lint warnings. Both are non-blocking (warnings); hard failures
              go through the 422 path and never reach here. */}
          {quality && <QualityBadge quality={quality} />}
          {lintWarnings.length > 0 && (
            <div className="rounded-lg border border-amber-700/40 bg-amber-900/10 px-3 py-2 text-xs text-amber-200 space-y-1">
              <div className="font-medium">
                Output quality warnings ({lintWarnings.length})
              </div>
              <ul className="list-disc pl-5 space-y-0.5">
                {lintWarnings.slice(0, 6).map((w, i) => (
                  <li key={`${w.code}-${i}`}>
                    <span className="text-amber-300/80">{w.field}:</span>{" "}
                    {w.message}
                  </li>
                ))}
                {lintWarnings.length > 6 && (
                  <li className="opacity-60">
                    …and {lintWarnings.length - 6} more.
                  </li>
                )}
              </ul>
            </div>
          )}
          <div className="flex items-center justify-between flex-wrap gap-2">
            <h2 className="text-sm font-semibold text-gray-300">
              Generated test cases ({results.length})
            </h2>
            {/* Phase 11.7 — E2E PR button. Uses activePlatform so it shows
                up correctly when source = custom (where the platform is
                read from customOutput rather than the wizard state). */}
            {conventions && (activePlatform === "ios" || activePlatform === "android") && (
              <button
                onClick={createE2EPr}
                disabled={creatingPr}
                className="btn-primary text-xs"
              >
                {creatingPr ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    Creating PR…
                  </>
                ) : (
                  <>Generate E2E PR in {conventions.e2e_repo_name ?? "new repo"}</>
                )}
              </button>
            )}
          </div>

          {prError && (
            <div className="text-xs text-red-400 border border-red-500/30 bg-red-500/10 rounded p-3 whitespace-pre-line">
              {prError}
            </div>
          )}
          {prResult && (
            <div className="text-xs border border-emerald-500/30 bg-emerald-500/10 rounded p-3 space-y-1">
              <div className="text-emerald-300 font-medium">
                ✓{" "}
                {prResult.pr_already_existed
                  ? `PR updated with new commits`
                  : `PR opened`}{" "}
                in {prResult.e2e_repo}
                {prResult.created_new_repo && " (new repo created)"}
              </div>
              <div className="text-gray-300">
                Branch: <code className="text-accent">{prResult.branch}</code> ·{" "}
                {prResult.files_committed} files committed · LLM:{" "}
                {prResult.provider_used}
              </div>
              <a
                href={prResult.pr_url}
                target="_blank"
                rel="noreferrer"
                className="text-accent hover:underline inline-block mt-1"
              >
                Open PR on GitHub →
              </a>
            </div>
          )}

          <div className="grid md:grid-cols-2 gap-4">
            {results.map((tc, i) => (
              <TestCaseCard
                key={tc.test_case_id ?? i}
                tc={tc}
                index={i}
                ticketId={activeTicket?.ticket_id}
                provider={providerUsed}
                judgeFlag={quality?.per_case_flags?.find(
                  (f) => f.test_case_id === tc.test_case_id,
                )}
              />
            ))}
          </div>
        </div>
      )}

      {/* Phase 13.2 — Saved tests / staleness panel.
          Shows whenever a repo is picked, independent of generation state. */}
      {repoFullName && (
        <SavedTestsPanel
          mainOwner={repoFullName.split("/")[0] ?? ""}
          mainRepo={repoFullName.split("/")[1] ?? ""}
        />
      )}
    </section>
  );
}

function PlatformPick({
  value,
  current,
  onPick,
  icon,
}: {
  value: Platform;
  current: Platform;
  onPick: (p: Platform) => void;
  icon: React.ReactNode;
}) {
  const active = value === current;
  return (
    <button
      onClick={() => onPick(value)}
      className={`flex flex-col items-center gap-1 px-2 py-2 rounded-lg border text-xs transition ${
        active
          ? "border-accent bg-accent/10 text-accent"
          : "border-border bg-bg-panel hover:bg-white/5 text-gray-300"
      }`}
    >
      {icon}
      <span className="capitalize">{value}</span>
    </button>
  );
}
