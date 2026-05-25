/**
 * @module lib/providers-from-session
 * Helpers that construct Jira / GitHub providers from session creds.
 * Centralised so route handlers don't repeat the construction or error handling.
 */

import {
  GitHubRestProvider,
  JiraCloudProvider,
  type GitHubProvider,
  type JiraProvider,
} from "@jiraqa/providers";
import type { SessionData } from "@jiraqa/core";

export function jiraFromSession(session: SessionData): JiraProvider {
  if (!session.jira) {
    throw new Error("Jira is not connected. Connect it from the Connections page.");
  }
  return new JiraCloudProvider({
    siteUrl: session.jira.site_url,
    email: session.jira.email,
    apiToken: session.jira.api_token,
  });
}

export function githubFromSession(session: SessionData): GitHubProvider {
  if (!session.github) {
    throw new Error("GitHub is not connected. Connect it from the Connections page.");
  }
  return new GitHubRestProvider({ pat: session.github.pat });
}
