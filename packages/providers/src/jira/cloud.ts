/**
 * @module @jiraqa/providers/jira/cloud
 * Jira Cloud REST v3 implementation.
 * Auth model: basic auth with `<email>:<api_token>` — simplest viable flow.
 * Docs: https://developer.atlassian.com/cloud/jira/platform/rest/v3/
 */

import type { JiraTicket } from "@jiraqa/core";
import type {
  JiraIssueSummary,
  JiraProject,
  JiraProvider,
} from "./types";

interface CloudCredentials {
  /** e.g. "acme.atlassian.net" — accept full URL too and we normalise. */
  siteUrl: string;
  email: string;
  apiToken: string;
}

function normaliseSiteUrl(input: string): string {
  let url = input.trim();
  url = url.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return url;
}

export class JiraCloudProvider implements JiraProvider {
  readonly name = "jira-cloud";
  private readonly siteUrl: string;
  private readonly authHeader: string;

  constructor(creds: CloudCredentials) {
    this.siteUrl = normaliseSiteUrl(creds.siteUrl);
    const token = Buffer.from(`${creds.email}:${creds.apiToken}`).toString("base64");
    this.authHeader = `Basic ${token}`;
  }

  private async req<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`https://${this.siteUrl}${path}`, {
      ...init,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: this.authHeader,
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Jira ${res.status}: ${text.slice(0, 500)}`);
    }
    return (await res.json()) as T;
  }

  async ping() {
    try {
      const me = await this.req<{ accountId: string; emailAddress?: string; displayName?: string }>(
        "/rest/api/3/myself",
      );
      return { ok: true as const, account: me.displayName ?? me.emailAddress ?? me.accountId };
    } catch (e) {
      return { ok: false as const, error: (e as Error).message };
    }
  }

  async listProjects(): Promise<JiraProject[]> {
    const data = await this.req<{
      values: Array<{ id: string; key: string; name: string; avatarUrls?: Record<string, string> }>;
    }>("/rest/api/3/project/search?maxResults=50");
    return data.values.map((p) => ({
      id: p.id,
      key: p.key,
      name: p.name,
      avatarUrl: p.avatarUrls?.["48x48"],
    }));
  }

  async searchIssues({
    projectKey,
    text,
    limit = 25,
  }: {
    projectKey?: string;
    text?: string;
    limit?: number;
  }): Promise<JiraIssueSummary[]> {
    // Build JQL — project key (unquoted is safer for keys), free-text, sort.
    const jqlParts: string[] = [];
    if (projectKey) jqlParts.push(`project = ${projectKey}`);
    if (text) jqlParts.push(`text ~ "${text.replace(/"/g, '\\"')}"`);
    const where = jqlParts.join(" AND ");
    const jql = where ? `${where} ORDER BY updated DESC` : "ORDER BY updated DESC";

    const fields = ["summary", "issuetype", "status", "priority", "updated"];

    // Try the modern endpoint first. Atlassian removed /rest/api/3/search in 2025
    // and replaced it with /rest/api/3/search/jql (POST, body-based, cursor pagination).
    type Issue = {
      key: string;
      fields: {
        summary: string;
        issuetype?: { name?: string };
        status?: { name?: string };
        priority?: { name?: string };
        updated?: string;
      };
    };

    let issues: Issue[] = [];
    try {
      const data = await this.req<{ issues: Issue[]; nextPageToken?: string }>(
        "/rest/api/3/search/jql",
        {
          method: "POST",
          body: JSON.stringify({
            jql,
            fields,
            maxResults: limit,
          }),
        },
      );
      issues = data.issues ?? [];
    } catch (modernErr) {
      // Legacy fallback — some Jira Server / Data Center instances still use the old endpoint.
      try {
        const data = await this.req<{ issues: Issue[] }>(
          `/rest/api/3/search?jql=${encodeURIComponent(jql)}&fields=${fields.join(",")}&maxResults=${limit}`,
        );
        issues = data.issues ?? [];
      } catch (legacyErr) {
        // Surface the modern error — it's the one that should work for Cloud.
        throw modernErr;
      }
    }

    return issues.map((i) => ({
      key: i.key,
      summary: i.fields.summary,
      issue_type: i.fields.issuetype?.name ?? "story",
      status: i.fields.status?.name ?? "unknown",
      priority: i.fields.priority?.name,
      updated: i.fields.updated,
    }));
  }

  async getIssue(key: string): Promise<JiraTicket> {
    const data = await this.req<{
      key: string;
      fields: {
        summary: string;
        description?: unknown; // ADF document
        issuetype?: { name?: string };
        priority?: { name?: string };
        components?: Array<{ name: string }>;
        labels?: string[];
        environment?: unknown;
        // Custom field for acceptance criteria is org-specific — we try common ones.
        [k: string]: unknown;
      };
    }>(
      `/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,description,issuetype,priority,components,labels,environment,customfield_10000,customfield_10010,customfield_10100`,
    );

    const description = adfToPlainText(data.fields.description);
    const environment = adfToPlainText(data.fields.environment);

    // Try to extract acceptance criteria from common custom fields.
    const acRaw =
      (data.fields["customfield_10000"] as unknown) ||
      (data.fields["customfield_10010"] as unknown) ||
      (data.fields["customfield_10100"] as unknown);
    const ac = adfToPlainText(acRaw);
    const acceptance_criteria = ac
      ? ac
          .split(/\r?\n/)
          .map((l) => l.replace(/^[-*\d.)\s]+/, "").trim())
          .filter(Boolean)
      : [];

    const issueType = (data.fields.issuetype?.name ?? "story").toLowerCase();
    const priority = (data.fields.priority?.name ?? "medium").toLowerCase();

    return {
      ticket_id: data.key,
      summary: data.fields.summary ?? "",
      description,
      acceptance_criteria,
      issue_type: mapIssueType(issueType),
      priority: mapPriority(priority),
      component: data.fields.components?.[0]?.name ?? "",
      labels: data.fields.labels ?? [],
      environment,
    };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

/**
 * Walk Atlassian Document Format (ADF) and extract plain text.
 * ADF is recursive — we flatten any node that has a `.text` or `.content[]`.
 */
function adfToPlainText(node: unknown): string {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(adfToPlainText).join("\n");
  if (typeof node === "object") {
    const obj = node as Record<string, unknown>;
    if (typeof obj.text === "string") return obj.text;
    if (Array.isArray(obj.content)) {
      const inner = obj.content.map(adfToPlainText).join(obj.type === "paragraph" ? "" : "\n");
      // List items get a leading bullet so the LLM can recognise them.
      if (obj.type === "listItem") return `- ${inner}`;
      return inner;
    }
  }
  return "";
}

function mapIssueType(name: string): JiraTicket["issue_type"] {
  if (name.includes("bug")) return "bug";
  if (name.includes("task")) return "task";
  if (name.includes("epic")) return "epic";
  if (name.includes("sub")) return "subtask";
  return "story";
}

function mapPriority(name: string): JiraTicket["priority"] {
  if (name.includes("critical") || name.includes("blocker") || name.includes("highest"))
    return "critical";
  if (name.includes("high")) return "high";
  if (name.includes("low") || name.includes("lowest") || name.includes("trivial")) return "low";
  return "medium";
}
