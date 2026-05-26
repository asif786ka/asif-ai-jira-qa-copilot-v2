"use client";

/**
 * Phase 13.2 Tier 2 — Saved tests panel.
 *
 * Shows all tests we've previously generated for the selected main repo,
 * across all platforms, with a clear "stale" badge when the main repo
 * has moved on since the test was generated.
 *
 * Re-fetches whenever the user picks a different repo in the Wizard.
 */

import { useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Hand,
  Loader2,
  RefreshCw,
  Wrench,
} from "lucide-react";

type TestEntry = {
  path: string;
  ticket_id?: string;
  source_sha?: string;
  generated_at?: string;
  stale: boolean;
  hand_edited: boolean;
  branch: string;
};

type SuiteEntry = {
  platform: string;
  e2e_repo: string;
  tests: TestEntry[];
};

type Response = {
  main_repo: string;
  main_head_sha: string;
  suites: SuiteEntry[];
};

type Props = {
  mainOwner: string;
  mainRepo: string;
};

export function SavedTestsPanel({ mainOwner, mainRepo }: Props) {
  const [data, setData] = useState<Response | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/e2e/staleness?main_owner=${encodeURIComponent(mainOwner)}&main_repo=${encodeURIComponent(mainRepo)}`,
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setData(json);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!mainOwner || !mainRepo) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mainOwner, mainRepo]);

  if (!mainOwner || !mainRepo) return null;

  const totalTests =
    data?.suites.reduce((sum, s) => sum + s.tests.length, 0) ?? 0;
  // Don't return null silently — always show the panel so users know the
  // feature exists. When there are no tests yet, show a helpful placeholder.

  const staleCount =
    data?.suites.reduce(
      (sum, s) => sum + s.tests.filter((t) => t.stale).length,
      0,
    ) ?? 0;
  const handEditedCount =
    data?.suites.reduce(
      (sum, s) => sum + s.tests.filter((t) => t.hand_edited).length,
      0,
    ) ?? 0;

  return (
    <section className="lg:col-span-12 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="text-sm font-semibold text-gray-300">
          Saved tests for {mainOwner}/{mainRepo}
          {data && (
            <span className="ml-2 text-xs text-gray-500 font-normal">
              ({totalTests} test{totalTests === 1 ? "" : "s"})
            </span>
          )}
        </h2>
        <button
          onClick={load}
          disabled={loading}
          className="btn-ghost text-xs"
          title="Re-check staleness"
        >
          {loading ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <RefreshCw className="w-3.5 h-3.5" />
          )}
          Refresh
        </button>
      </div>

      {(staleCount > 0 || handEditedCount > 0) && (
        <div className="flex flex-wrap gap-2 text-[11px]">
          {staleCount > 0 && (
            <span className="pill text-amber-300 border-amber-500/40 bg-amber-500/10">
              <AlertTriangle className="w-3 h-3" />
              {staleCount} stale (main repo has moved on)
            </span>
          )}
          {handEditedCount > 0 && (
            <span className="pill text-sky-300 border-sky-500/40 bg-sky-500/10">
              <Hand className="w-3 h-3" />
              {handEditedCount} hand-edited (preserved on regenerate)
            </span>
          )}
        </div>
      )}

      {error && (
        <div className="text-xs text-red-400 border border-red-500/30 bg-red-500/10 rounded p-3">
          {error}
        </div>
      )}

      <div className="card space-y-3">
        {loading && !data && (
          <div className="text-xs text-gray-400 flex items-center gap-2">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            Checking saved tests in {mainOwner}/{mainRepo}-*-e2e ...
          </div>
        )}

        {!loading && data && data.suites.length === 0 && (
          <div className="text-xs text-gray-500 italic leading-relaxed">
            No e2e repos found yet for{" "}
            <span className="text-gray-300">
              {mainOwner}/{mainRepo}
            </span>
            . When you click <strong>Generate E2E PR</strong>, we'll create{" "}
            <code className="text-accent">
              {mainRepo}-ios-e2e
            </code>{" "}
            (or <code>-android-e2e</code>) under your GitHub account.
            Generated tests will then show up here with stale / hand-edited badges.
          </div>
        )}

        {!loading && data && data.suites.length > 0 && totalTests === 0 && (
          <div className="text-xs text-gray-500 italic">
            E2E repo exists but <code>e2e/flows/</code> is empty. Generate a
            test from a Jira ticket or custom scenario above.
          </div>
        )}

        {data?.suites.map((suite) => (
          <div key={suite.platform} className="space-y-2">
            <div className="text-[11px] uppercase tracking-wide text-gray-500">
              {suite.platform} ·{" "}
              <a
                href={`https://github.com/${suite.e2e_repo}`}
                target="_blank"
                rel="noreferrer"
                className="text-accent hover:underline inline-flex items-center gap-1"
              >
                {suite.e2e_repo}
                <ExternalLink className="w-2.5 h-2.5" />
              </a>
            </div>
            {suite.tests.length === 0 ? (
              <div className="text-[11px] text-gray-500 italic">
                no test flows yet
              </div>
            ) : (
              <ul className="space-y-1.5">
                {suite.tests.map((t) => (
                  <li
                    key={t.path}
                    className="flex items-center justify-between gap-2 text-xs p-2 rounded border border-border bg-bg-panel"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      {t.hand_edited ? (
                        <Hand className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                      ) : t.stale ? (
                        <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                      ) : (
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                      )}
                      <span className="font-mono text-[11px] truncate">
                        {t.path}
                      </span>
                      {t.ticket_id && (
                        <span className="pill text-[10px]">{t.ticket_id}</span>
                      )}
                      {t.branch !== "main" && (
                        <span className="pill text-[10px] text-amber-300 border-amber-500/40 bg-amber-500/10">
                          pending PR
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-gray-500 flex items-center gap-2 shrink-0">
                      {t.hand_edited ? (
                        "hand-edited"
                      ) : t.stale ? (
                        <>
                          <span className="text-amber-300">stale</span>
                          <span>
                            {t.source_sha?.slice(0, 7)} →{" "}
                            {data.main_head_sha.slice(0, 7)}
                          </span>
                        </>
                      ) : (
                        <span className="text-emerald-300">in sync</span>
                      )}
                      <a
                        href={`https://github.com/${suite.e2e_repo}/blob/${encodeURIComponent(t.branch)}/${t.path}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-accent hover:underline"
                        title={`View on ${t.branch}`}
                      >
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>

      <p className="text-[11px] text-gray-500">
        <Wrench className="inline w-3 h-3 mr-1" />
        Stale tests can be regenerated by re-running the wizard for the same
        ticket — the marker on the flow file is updated and your hand-edits
        (if any) are preserved as <code>.v2</code> alongside.
      </p>
    </section>
  );
}
