"use client";

/**
 * Phase 14.2 — DORA dashboard.
 *
 * Lets the user pick a GitHub repo + Jira project + time window, then
 * fetches /api/dora/metrics and renders four big-number cards with DORA
 * tier classification. Also fires a follow-up call to generate an LLM
 * insight ("what's slowing you down?") that appears below the cards.
 */

import { useEffect, useState } from "react";
import type { DoraResponse, DoraTier } from "@jiraqa/core";
import {
  AlertTriangle,
  ArrowUpRight,
  Clock,
  Loader2,
  PackageCheck,
  Rocket,
  Sparkles,
  Timer,
} from "lucide-react";

type SessionView = {
  jira: { site_url: string; email: string; connected: true } | null;
  github: { login: string | null; connected: true } | null;
};

type JiraProject = { id: string; key: string; name: string };
type GitHubRepoSummary = {
  full_name: string;
  owner: string;
  name: string;
};

export function DoraDashboard() {
  const [session, setSession] = useState<SessionView | null>(null);
  const [projects, setProjects] = useState<JiraProject[]>([]);
  const [repos, setRepos] = useState<GitHubRepoSummary[]>([]);
  const [repoFullName, setRepoFullName] = useState("");
  const [projectKey, setProjectKey] = useState("");
  const [days, setDays] = useState(30);
  const [data, setData] = useState<DoraResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [insight, setInsight] = useState<string | null>(null);
  const [insightLoading, setInsightLoading] = useState(false);

  // ── load session + dropdowns ───────────────────────────────────────────
  useEffect(() => {
    fetch("/api/connections/save")
      .then((r) => r.json())
      .then((d) => setSession(d.session))
      .catch(() => {});
  }, []);

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

  // ── compute on demand ──────────────────────────────────────────────────
  async function compute() {
    if (!repoFullName) return;
    const [owner, repo] = repoFullName.split("/");
    if (!owner || !repo) return;
    setLoading(true);
    setError(null);
    setData(null);
    setInsight(null);
    try {
      const qs = new URLSearchParams({ owner, repo, days: String(days) });
      if (projectKey) qs.set("project", projectKey);
      const res = await fetch(`/api/dora/metrics?${qs.toString()}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setData(json);
      // Fire-and-forget insight call
      void fetchInsight(json);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function fetchInsight(d: DoraResponse) {
    setInsightLoading(true);
    try {
      const res = await fetch("/api/dora/insight", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ metrics: d }),
      });
      const json = await res.json();
      if (res.ok && json.insight) setInsight(json.insight);
    } catch {
      // non-fatal — dashboard still works without the insight
    } finally {
      setInsightLoading(false);
    }
  }

  if (!session) {
    return (
      <div className="card text-sm text-gray-400 flex items-center gap-2">
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading session...
      </div>
    );
  }

  if (!session.jira || !session.github) {
    return (
      <div className="card text-center">
        <AlertTriangle className="w-6 h-6 text-yellow-400 mx-auto mb-2" />
        <p className="text-sm text-gray-300">
          Connect <strong>Jira</strong> and <strong>GitHub</strong> first.
        </p>
        <a href="/connections" className="btn-primary mt-3 inline-flex">
          Go to Connections
        </a>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <section className="card grid md:grid-cols-4 gap-3">
        <div>
          <label className="text-xs text-gray-400">GitHub repo</label>
          <select
            className="input mt-1"
            value={repoFullName}
            onChange={(e) => setRepoFullName(e.target.value)}
          >
            <option value="">— pick repo —</option>
            {repos.map((r) => (
              <option key={r.full_name} value={r.full_name}>
                {r.full_name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-xs text-gray-400">Jira project</label>
          <select
            className="input mt-1"
            value={projectKey}
            onChange={(e) => setProjectKey(e.target.value)}
          >
            <option value="">— all projects —</option>
            {projects.map((p) => (
              <option key={p.key} value={p.key}>
                [{p.key}] {p.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-xs text-gray-400">Window</label>
          <select
            className="input mt-1"
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
          >
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={60}>Last 60 days</option>
            <option value={90}>Last 90 days</option>
          </select>
        </div>
        <div className="flex items-end">
          <button
            onClick={compute}
            disabled={!repoFullName || loading}
            className="btn-primary w-full"
          >
            {loading ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> Computing...
              </>
            ) : (
              <>Compute DORA</>
            )}
          </button>
        </div>
      </section>

      {error && (
        <div className="text-xs text-red-400 border border-red-500/30 bg-red-500/10 rounded p-3">
          {error}
        </div>
      )}

      {data && (
        <>
          <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <MetricCard
              title="Deployment frequency"
              icon={<Rocket className="w-4 h-4" />}
              value={
                data.deployment_frequency.value !== null
                  ? data.deployment_frequency.value.toFixed(1)
                  : "—"
              }
              unit={data.deployment_frequency.unit}
              tier={data.deployment_frequency.tier}
              description={data.deployment_frequency.description}
            />
            <MetricCard
              title="Lead time"
              icon={<Timer className="w-4 h-4" />}
              value={
                data.lead_time_hours.value !== null
                  ? formatLeadTime(data.lead_time_hours.value)
                  : "—"
              }
              unit=""
              tier={data.lead_time_hours.tier}
              description={data.lead_time_hours.description}
            />
            <MetricCard
              title="Change failure rate"
              icon={<AlertTriangle className="w-4 h-4" />}
              value={
                data.change_failure_rate.value !== null
                  ? `${(data.change_failure_rate.value * 100).toFixed(0)}%`
                  : "—"
              }
              unit=""
              tier={data.change_failure_rate.tier}
              description={data.change_failure_rate.description}
            />
            <MetricCard
              title="MTTR"
              icon={<Clock className="w-4 h-4" />}
              value={
                data.mttr_hours.value !== null
                  ? formatLeadTime(data.mttr_hours.value)
                  : "—"
              }
              unit=""
              tier={data.mttr_hours.tier}
              description={data.mttr_hours.description}
            />
          </section>

          <section className="card text-xs text-gray-400 flex items-center gap-3 flex-wrap">
            <span className="pill">
              <PackageCheck className="w-3 h-3" /> {data.sample.merged_prs}{" "}
              merged PRs
            </span>
            <span className="pill">
              <AlertTriangle className="w-3 h-3" /> {data.sample.incidents}{" "}
              incidents
            </span>
            <span className="pill">
              <PackageCheck className="w-3 h-3" />{" "}
              {data.sample.resolved_incidents} resolved
            </span>
            <span className="ml-auto">
              Source: {data.source.main_repo}
              {data.source.jira_project && ` · ${data.source.jira_project}`}
            </span>
          </section>

          <section className="card space-y-2">
            <div className="flex items-center gap-2">
              <Sparkles className="w-3.5 h-3.5 text-accent" />
              <h3 className="text-sm font-semibold">AI insight</h3>
            </div>
            {insightLoading && !insight ? (
              <div className="text-xs text-gray-400 flex items-center gap-2">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Analysing your bottleneck...
              </div>
            ) : insight ? (
              <p className="text-sm text-gray-300 leading-relaxed">{insight}</p>
            ) : (
              <p className="text-xs text-gray-500 italic">
                AI insight will appear here when ready.
              </p>
            )}
          </section>
        </>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Sub-components
// ────────────────────────────────────────────────────────────────────────────

const TIER_STYLES: Record<DoraTier, string> = {
  elite: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  high: "border-sky-500/40 bg-sky-500/10 text-sky-300",
  medium: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  low: "border-red-500/40 bg-red-500/10 text-red-300",
  unknown: "border-border bg-bg-panel text-gray-400",
};

const TIER_LABEL: Record<DoraTier, string> = {
  elite: "Elite",
  high: "High",
  medium: "Medium",
  low: "Low",
  unknown: "—",
};

function MetricCard({
  title,
  icon,
  value,
  unit,
  tier,
  description,
}: {
  title: string;
  icon: React.ReactNode;
  value: string;
  unit: string;
  tier: DoraTier;
  description: string;
}) {
  return (
    <div className="card flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-xs text-gray-400">
          {icon}
          {title}
        </div>
        <span className={`pill ${TIER_STYLES[tier]}`}>
          {TIER_LABEL[tier]}
        </span>
      </div>
      <div className="flex items-baseline gap-1">
        <span className="text-3xl font-semibold">{value}</span>
        {unit && <span className="text-xs text-gray-500">{unit}</span>}
        {tier === "elite" && (
          <ArrowUpRight className="w-3.5 h-3.5 text-emerald-400 ml-auto" />
        )}
      </div>
      <p className="text-[11px] text-gray-500 leading-snug">{description}</p>
    </div>
  );
}

function formatLeadTime(hours: number): string {
  if (hours < 1) return `${(hours * 60).toFixed(0)}m`;
  if (hours < 24) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}
