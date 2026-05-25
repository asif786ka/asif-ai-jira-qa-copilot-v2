"use client";

import { useEffect, useState } from "react";
import type { JiraTicket, Platform, RepoContext, TestCase } from "@jiraqa/core";
import { Loader2, Smartphone, Apple, Globe, AlertTriangle } from "lucide-react";
import { TestCaseCard } from "./TestCaseCard";
import { getActiveBackend } from "./BackendSwitcher";

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

  // ── Generate ────────────────────────────────────────────────────────────
  async function generate() {
    if (!ticket) return;
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
          ticket,
          platform,
          repo_context: repoContext ?? undefined,
          count_hint: 5,
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
      {/* Left: Jira ticket picker */}
      <div className="lg:col-span-4 space-y-3">
        <h2 className="text-sm font-semibold text-gray-300">1. Jira ticket</h2>
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
        </div>
      </div>

      {/* Right: Generate */}
      <div className="lg:col-span-4 space-y-3">
        <h2 className="text-sm font-semibold text-gray-300">3. Generate</h2>
        <div className="card space-y-3">
          <button
            className="btn-primary w-full"
            onClick={generate}
            disabled={!ticket || generating}
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
          <h2 className="text-sm font-semibold text-gray-300">Generated test cases ({results.length})</h2>
          <div className="grid md:grid-cols-2 gap-4">
            {results.map((tc, i) => (
              <TestCaseCard key={tc.test_case_id ?? i} tc={tc} index={i} />
            ))}
          </div>
        </div>
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
