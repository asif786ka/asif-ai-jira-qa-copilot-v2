/**
 * @module @jiraqa/providers/jira/types
 * Jira provider contract — same swappable pattern as the LLM layer.
 * Add Server / Data Center variant later by implementing this interface.
 */

import type { JiraTicket } from "@jiraqa/core";

export interface JiraProject {
  id: string;
  key: string;
  name: string;
  avatarUrl?: string;
}

export interface JiraIssueSummary {
  key: string;
  summary: string;
  issue_type: string;
  status: string;
  priority?: string;
  updated?: string;
}

export interface JiraProvider {
  readonly name: string;
  /** Verify credentials work — used by /api/connections/test. */
  ping(): Promise<{ ok: true; account: string } | { ok: false; error: string }>;
  listProjects(): Promise<JiraProject[]>;
  searchIssues(opts: {
    projectKey?: string;
    text?: string;
    limit?: number;
  }): Promise<JiraIssueSummary[]>;
  /** Returns a canonical JiraTicket ready to feed the prompt builder. */
  getIssue(key: string): Promise<JiraTicket>;
}
