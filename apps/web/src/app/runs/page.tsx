"use client";

/**
 * /runs — Test-run dashboard.
 *
 * Lists recent GitHub Actions executions across every E2E repo the user
 * has configured. Each row maps back to a Jira ticket (via the
 * jiraqa/<ticket-slug> branch convention), shows status, duration, and
 * direct links to both the workflow run and its artifacts.
 *
 * The aggregate KPIs at the top — success rate, mean duration, recent
 * count — are the numbers an Agentic SDLC adoption review wants to see.
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  ExternalLink,
  Loader2,
  RefreshCw,
  XCircle,
} from "lucide-react";

type Run = {
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
};

type RunsResponse = {
  runs: Run[];
  repos_scanned: string[];
  errors: Array<{ repo: string; message: string }>;
};

function fmtDuration(ms: number | null): string {
  if (ms == null) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return `${m}m ${rs}s`;
}

function fmtAgo(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const diff = Date.now() - then;
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function StatusBadge({ status, conclusion }: { status: string; conclusion: string | null }) {
  if (status === "completed") {
    if (conclusion === "success") {
      return (
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
          <CheckCircle2 className="w-3 h-3" /> passed
        </span>
      );
    }
    if (conclusion === "failure") {
      return (
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium bg-red-500/15 text-red-300 border border-red-500/30">
          <XCircle className="w-3 h-3" /> failed
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium bg-gray-500/15 text-gray-300 border border-gray-500/30">
        {conclusion ?? "unknown"}
      </span>
    );
  }
  if (status === "in_progress" || status === "queued") {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium bg-amber-500/15 text-amber-300 border border-amber-500/30">
        <Loader2 className="w-3 h-3 animate-spin" /> {status.replace("_", " ")}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium bg-gray-500/15 text-gray-300 border border-gray-500/30">
      {status}
    </span>
  );
}

export default function RunsDashboard() {
  const [data, setData] = useState<RunsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/runs", { cache: "no-store" });
      const json = (await res.json()) as RunsResponse & { error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setData(json);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  // KPIs.
  const kpis = useMemo(() => {
    const runs = data?.runs ?? [];
    const completed = runs.filter((r) => r.status === "completed");
    const passed = completed.filter((r) => r.conclusion === "success").length;
    const successRate =
      completed.length === 0 ? null : Math.round((passed / completed.length) * 100);
    const durations = runs
      .map((r) => r.duration_ms ?? 0)
      .filter((d) => d > 0);
    const meanDur =
      durations.length === 0
        ? null
        : Math.round(durations.reduce((a, b) => a + b, 0) / durations.length);
    return {
      total: runs.length,
      completed: completed.length,
      passed,
      failed: completed.length - passed,
      successRate,
      meanDurationMs: meanDur,
      inFlight: runs.filter((r) => r.status !== "completed").length,
    };
  }, [data]);

  return (
    <main className="min-h-screen px-6 py-10 max-w-6xl mx-auto">
      <header className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-gray-100">Test-run dashboard</h1>
          <p className="text-xs text-gray-400 mt-1">
            Recent GitHub Actions executions across your configured E2E repos.
            <Link href="/" className="ml-2 text-accent hover:underline">
              ← Back to generator
            </Link>
          </p>
        </div>
        <button
          onClick={() => void load()}
          disabled={loading}
          className="btn-secondary text-xs flex items-center gap-1.5"
        >
          {loading ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <RefreshCw className="w-3.5 h-3.5" />
          )}
          Refresh
        </button>
      </header>

      {error && (
        <div className="card border-red-500/30 bg-red-500/10 text-red-300 text-sm mb-4 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 mt-0.5" />
          <div>
            <div className="font-medium">Could not load runs</div>
            <div className="text-xs opacity-80 mt-0.5">{error}</div>
          </div>
        </div>
      )}

      {/* KPIs */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <KpiCard label="Total runs" value={String(kpis.total)} />
        <KpiCard
          label="Success rate"
          value={kpis.successRate == null ? "—" : `${kpis.successRate}%`}
          accent={
            kpis.successRate == null
              ? undefined
              : kpis.successRate >= 90
                ? "good"
                : kpis.successRate >= 70
                  ? "warn"
                  : "bad"
          }
        />
        <KpiCard
          label="Mean duration"
          value={fmtDuration(kpis.meanDurationMs)}
        />
        <KpiCard
          label="In flight"
          value={String(kpis.inFlight)}
          accent={kpis.inFlight > 0 ? "warn" : undefined}
        />
      </div>

      {/* Table */}
      <div className="card overflow-hidden p-0">
        <table className="w-full text-sm">
          <thead className="bg-white/5 text-[11px] uppercase tracking-wide text-gray-400">
            <tr>
              <th className="text-left px-3 py-2">Status</th>
              <th className="text-left px-3 py-2">Ticket</th>
              <th className="text-left px-3 py-2">Workflow</th>
              <th className="text-left px-3 py-2">Repo</th>
              <th className="text-left px-3 py-2">Duration</th>
              <th className="text-left px-3 py-2">When</th>
              <th className="text-right px-3 py-2">Links</th>
            </tr>
          </thead>
          <tbody>
            {(data?.runs ?? []).map((r) => (
              <tr
                key={r.run_id}
                className="border-t border-white/5 hover:bg-white/[0.03]"
              >
                <td className="px-3 py-2">
                  <StatusBadge status={r.status} conclusion={r.conclusion} />
                </td>
                <td className="px-3 py-2 font-mono text-xs text-gray-200">
                  {r.ticket_id ?? <span className="text-gray-500">—</span>}
                </td>
                <td className="px-3 py-2 text-gray-300">{r.workflow_name}</td>
                <td className="px-3 py-2 text-gray-400 font-mono text-xs">{r.repo}</td>
                <td className="px-3 py-2 text-gray-300">
                  <span className="inline-flex items-center gap-1">
                    <Clock className="w-3 h-3 opacity-70" />
                    {fmtDuration(r.duration_ms)}
                  </span>
                </td>
                <td className="px-3 py-2 text-gray-400">{fmtAgo(r.created_at)}</td>
                <td className="px-3 py-2 text-right">
                  <a
                    href={r.html_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-accent hover:underline inline-flex items-center gap-1 text-xs"
                  >
                    Run <ExternalLink className="w-3 h-3" />
                  </a>{" "}
                  <a
                    href={`${r.html_url}#artifacts`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-accent hover:underline inline-flex items-center gap-1 text-xs ml-2"
                  >
                    Artifacts <ExternalLink className="w-3 h-3" />
                  </a>
                </td>
              </tr>
            ))}
            {!loading && (data?.runs ?? []).length === 0 && (
              <tr>
                <td
                  colSpan={7}
                  className="px-3 py-12 text-center text-gray-400 text-sm"
                >
                  {data?.repos_scanned.length === 0
                    ? "No E2E repos configured yet. Generate test cases from a ticket to start one."
                    : "No workflow runs found yet — they will appear here as the agentic PRs trigger CI."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {(data?.errors ?? []).length > 0 && (
        <div className="mt-4 text-xs text-amber-300/80 space-y-1">
          {data!.errors.map((er) => (
            <div key={er.repo}>
              <span className="font-mono">{er.repo}</span>: {er.message}
            </div>
          ))}
        </div>
      )}

      {(data?.repos_scanned ?? []).length > 0 && (
        <div className="mt-3 text-[11px] text-gray-500">
          Scanned: {data!.repos_scanned.join(", ")}
        </div>
      )}
    </main>
  );
}

function KpiCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: "good" | "warn" | "bad";
}) {
  const accentClass =
    accent === "good"
      ? "text-emerald-300"
      : accent === "warn"
        ? "text-amber-300"
        : accent === "bad"
          ? "text-red-300"
          : "text-gray-100";
  return (
    <div className="card py-3">
      <div className="text-[11px] uppercase tracking-wide text-gray-400">
        {label}
      </div>
      <div className={`text-2xl font-semibold mt-1 ${accentClass}`}>{value}</div>
    </div>
  );
}
