/**
 * @module lib/session
 * Encrypted-cookie session via iron-session. Stores Jira / GitHub tokens
 * inside an HttpOnly, SameSite=Lax, Secure cookie. Never localStorage.
 *
 * SaaS upgrade path:
 *   - When you add real accounts, swap `SessionData` for `{ user_id }`
 *     and move tokens to a DB table keyed by user_id (encrypted at rest).
 *   - The route handlers below stay the same shape.
 */

import { getIronSession, type SessionOptions } from "iron-session";
import { cookies } from "next/headers";
import type { SessionData } from "@jiraqa/core";

export const sessionOptions: SessionOptions = {
  password:
    process.env.SESSION_SECRET ??
    // Dev-only fallback so the app boots without crashing.
    "dev-only-fallback-secret-please-set-SESSION_SECRET-min-32-chars!!",
  cookieName: "jiraqa_session",
  cookieOptions: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 7, // 7 days
  },
};

export async function getSession() {
  const store = await cookies();
  return getIronSession<SessionData>(store, sessionOptions);
}

/** Convenience: redacted view safe to send to the browser. */
export function publicView(session: SessionData) {
  return {
    jira: session.jira
      ? { site_url: session.jira.site_url, email: session.jira.email, connected: true }
      : null,
    github: session.github
      ? { login: session.github.login ?? null, connected: true }
      : null,
    preferred_provider: session.preferred_provider ?? null,
    preferred_backend: session.preferred_backend ?? null,
  };
}
