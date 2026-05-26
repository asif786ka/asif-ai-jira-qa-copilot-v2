"use client";

import { useEffect, useState } from "react";
import type {
  JiraTicket,
  Platform,
  RepoContext,
  RepoConventions,
  Screenshot,
  TestCase,
} from "@jiraqa/core";
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
import { SavedTestsPanel } from "./SavedTestsPanel";

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

  // ── Generate ────────────────────────────────────────────────────────────
  async function generate() {
    if (!activeTicket) return;
    setGenerating(true);
    setError(null);
    setResults(null);
    setProviderUsed("");
    setBackendUsed("");
    try {
      const backend = getActiveBackend();
      const endpoint = backend === "python" ? "/pyapi/generate" : "/api/generate";
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ticket: activeTicket,
          platform: activePlatform,
          repo_context: repoContext ?? undefined,
          count_hint: 5,
          screenshots: activeScreenshots,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Generation failed");
      setResults(data.generated_test_cases ?? []);
      setProviderUsed(data.provider ?? "");
      setBackendUsed(data.backend ?? backend);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setGenerating(false);
    }
  }

  // ── Phase 11.7 — Create the E2E PR ──────────────────────────────────────
  async function createE2EPr() {
    if (!ticket || !results || !repoFullName) return;
    const [owner, repo] = repoFullName.split("/");
    if (!owner || !repo) return;
    setCreatingPr(true);
    setPrError(null);
    setPrResult(null);
    try {
      const res = await fetch("/api/e2e/generate-pr", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ticket,
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
          <button
            className="btn-primary w-full"
            onClick={generate}
            disabled={!activeTicket || generating}
          >
            {generating ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" /> Generating...
              </>
            ) : (
              "Generate test cases"
            )}
          </button>
          {error && (
            <div className="text-xs text-red-400 border border-red-500/30 bg-red-500/10 rounded-lg p-3">
              {error}
            </div>
          )}
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
          <div className="flex items-center justify-between flex-wrap gap-2">
            <h2 className="text-sm font-semibold text-gray-300">
              Generated test cases ({results.length})
            </h2>
            {/* Phase 11.7 — E2E PR button */}
            {conventions && (platform === "ios" || platform === "android") && (
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
              <TestCaseCard key={tc.test_case_id ?? i} tc={tc} index={i} />
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
