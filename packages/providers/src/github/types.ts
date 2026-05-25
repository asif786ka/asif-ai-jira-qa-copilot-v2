/**
 * @module @jiraqa/providers/github/types
 * GitHub provider contract — pluggable for GitLab/Bitbucket later.
 */

import type { Platform, RepoContext } from "@jiraqa/core";

export interface GitHubRepoSummary {
  full_name: string; // "owner/repo"
  owner: string;
  name: string;
  default_branch: string;
  private: boolean;
  language?: string;
  description?: string;
  updated_at?: string;
  stargazers_count?: number;
}

export interface GitHubProvider {
  readonly name: string;
  ping(): Promise<{ ok: true; login: string } | { ok: false; error: string }>;
  listRepos(opts?: { limit?: number }): Promise<GitHubRepoSummary[]>;
  /** Build a curated RepoContext + detect mobile/web platforms. */
  buildContext(owner: string, repo: string): Promise<RepoContext>;
  detectPlatforms(filePaths: string[]): Platform[];
}
