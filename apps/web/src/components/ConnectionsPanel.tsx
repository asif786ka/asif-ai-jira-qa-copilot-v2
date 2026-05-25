"use client";

import { useEffect, useState } from "react";
import { Github, CheckCircle2, XCircle, Loader2, Plug, Unplug } from "lucide-react";

type SessionView = {
  jira: { site_url: string; email: string; connected: true } | null;
  github: { login: string | null; connected: true } | null;
};

export function ConnectionsPanel() {
  const [session, setSession] = useState<SessionView | null>(null);

  const refresh = () =>
    fetch("/api/connections/save")
      .then((r) => r.json())
      .then((d) => setSession(d.session))
      .catch(() => {});

  useEffect(() => {
    refresh();
  }, []);

  async function disconnect() {
    await fetch("/api/connections/clear", { method: "POST" });
    await refresh();
  }

  return (
    <div className="grid md:grid-cols-2 gap-4">
      <JiraCard
        connected={session?.jira ?? null}
        onSaved={refresh}
      />
      <GitHubCard
        connected={session?.github ?? null}
        onSaved={refresh}
      />
      {(session?.jira || session?.github) && (
        <div className="md:col-span-2">
          <button onClick={disconnect} className="btn-ghost">
            <Unplug className="w-4 h-4" /> Disconnect everything
          </button>
        </div>
      )}
    </div>
  );
}

function JiraCard({
  connected,
  onSaved,
}: {
  connected: SessionView["jira"];
  onSaved: () => void;
}) {
  const [siteUrl, setSiteUrl] = useState("");
  const [email, setEmail] = useState("");
  const [token, setToken] = useState("");
  const [status, setStatus] = useState<null | { ok: boolean; msg: string }>(null);
  const [busy, setBusy] = useState(false);

  async function test() {
    setBusy(true);
    setStatus(null);
    const res = await fetch("/api/connections/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jira: { site_url: siteUrl, email, api_token: token },
      }),
    });
    const data = await res.json();
    const j = data.jira;
    setStatus(
      j?.ok
        ? { ok: true, msg: `Connected as ${j.account}` }
        : { ok: false, msg: j?.error ?? "Test failed" },
    );
    setBusy(false);
  }

  async function save() {
    setBusy(true);
    await fetch("/api/connections/save", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jira: { site_url: siteUrl, email, api_token: token },
      }),
    });
    setBusy(false);
    onSaved();
  }

  if (connected) {
    return (
      <div className="card">
        <div className="flex items-center gap-2 mb-2">
          <img
            src="https://cdn.simpleicons.org/jira"
            alt="Jira"
            className="w-5 h-5"
            onError={(e) => (e.currentTarget.style.display = "none")}
          />
          <h3 className="text-sm font-semibold">Jira Cloud</h3>
          <span className="pill text-emerald-300 border-emerald-500/40 bg-emerald-500/10">
            <CheckCircle2 className="w-3 h-3" /> connected
          </span>
        </div>
        <div className="text-xs text-gray-400">
          <div>
            <span className="text-gray-500">Site:</span> {connected.site_url}
          </div>
          <div>
            <span className="text-gray-500">Email:</span> {connected.email}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="card space-y-3">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold">Jira Cloud</h3>
        <span className="pill text-gray-400">not connected</span>
      </div>
      <p className="text-xs text-gray-400">
        Create an API token at{" "}
        <a
          href="https://id.atlassian.com/manage-profile/security/api-tokens"
          target="_blank"
          rel="noreferrer"
          className="text-accent hover:underline"
        >
          id.atlassian.com → API tokens
        </a>
        .
      </p>
      <div className="space-y-2">
        <label className="block text-xs text-gray-400">
          Site URL
          <input
            value={siteUrl}
            onChange={(e) => setSiteUrl(e.target.value)}
            placeholder="acme.atlassian.net"
            className="input mt-1"
          />
        </label>
        <label className="block text-xs text-gray-400">
          Email
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
            className="input mt-1"
          />
        </label>
        <label className="block text-xs text-gray-400">
          API token
          <input
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="ATATT3..."
            type="password"
            className="input mt-1"
          />
        </label>
      </div>
      {status && (
        <div
          className={`text-xs flex items-center gap-2 ${
            status.ok ? "text-emerald-400" : "text-red-400"
          }`}
        >
          {status.ok ? <CheckCircle2 className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />}
          {status.msg}
        </div>
      )}
      <div className="flex gap-2">
        <button className="btn-ghost flex-1" onClick={test} disabled={busy}>
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null} Test
        </button>
        <button
          className="btn-primary flex-1"
          onClick={save}
          disabled={busy || !siteUrl || !email || !token}
        >
          <Plug className="w-3.5 h-3.5" /> Save
        </button>
      </div>
    </div>
  );
}

function GitHubCard({
  connected,
  onSaved,
}: {
  connected: SessionView["github"];
  onSaved: () => void;
}) {
  const [pat, setPat] = useState("");
  const [status, setStatus] = useState<null | { ok: boolean; msg: string }>(null);
  const [busy, setBusy] = useState(false);

  async function test() {
    setBusy(true);
    setStatus(null);
    const res = await fetch("/api/connections/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ github: { pat } }),
    });
    const data = await res.json();
    const g = data.github;
    setStatus(
      g?.ok
        ? { ok: true, msg: `Connected as ${g.login}` }
        : { ok: false, msg: g?.error ?? "Test failed" },
    );
    setBusy(false);
  }

  async function save() {
    setBusy(true);
    await fetch("/api/connections/save", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ github: { pat } }),
    });
    setBusy(false);
    onSaved();
  }

  if (connected) {
    return (
      <div className="card">
        <div className="flex items-center gap-2 mb-2">
          <Github className="w-5 h-5" />
          <h3 className="text-sm font-semibold">GitHub</h3>
          <span className="pill text-emerald-300 border-emerald-500/40 bg-emerald-500/10">
            <CheckCircle2 className="w-3 h-3" /> connected
          </span>
        </div>
        <div className="text-xs text-gray-400">
          <span className="text-gray-500">Login:</span> {connected.login ?? "(token saved)"}
        </div>
      </div>
    );
  }

  return (
    <div className="card space-y-3">
      <div className="flex items-center gap-2">
        <Github className="w-5 h-5" />
        <h3 className="text-sm font-semibold">GitHub</h3>
        <span className="pill text-gray-400">not connected</span>
      </div>
      <p className="text-xs text-gray-400">
        Create a fine-grained PAT at{" "}
        <a
          href="https://github.com/settings/personal-access-tokens/new"
          target="_blank"
          rel="noreferrer"
          className="text-accent hover:underline"
        >
          github.com → fine-grained tokens
        </a>
        . Required scopes: <code className="text-gray-300">repo (read)</code>,{" "}
        <code className="text-gray-300">metadata</code>.
      </p>
      <label className="block text-xs text-gray-400">
        Personal Access Token
        <input
          value={pat}
          onChange={(e) => setPat(e.target.value)}
          placeholder="github_pat_..."
          type="password"
          className="input mt-1"
        />
      </label>
      {status && (
        <div
          className={`text-xs flex items-center gap-2 ${
            status.ok ? "text-emerald-400" : "text-red-400"
          }`}
        >
          {status.ok ? <CheckCircle2 className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />}
          {status.msg}
        </div>
      )}
      <div className="flex gap-2">
        <button className="btn-ghost flex-1" onClick={test} disabled={busy}>
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null} Test
        </button>
        <button className="btn-primary flex-1" onClick={save} disabled={busy || !pat}>
          <Plug className="w-3.5 h-3.5" /> Save
        </button>
      </div>
    </div>
  );
}
