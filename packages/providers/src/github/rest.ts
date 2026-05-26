/**
 * @module @jiraqa/providers/github/rest
 * GitHub REST v3 implementation. PAT-based auth (fine-grained or classic).
 * No SDK — small bundle, no version drift.
 */

import type { Platform, RepoContext } from "@jiraqa/core";
import type {
  GitHubProvider,
  GitHubRepoSummary,
} from "./types";

const GH_API = "https://api.github.com";

interface GitHubCredentials {
  pat: string;
}

// Fingerprints used for platform auto-detection.
// Ordered most-specific first.
const PLATFORM_FINGERPRINTS: Array<{
  platform: Platform;
  matchers: Array<RegExp>;
}> = [
  {
    platform: "android",
    matchers: [
      /(^|\/)AndroidManifest\.xml$/i,
      /(^|\/)build\.gradle(\.kts)?$/i,
      /(^|\/)gradle\.properties$/i,
      /(^|\/)settings\.gradle(\.kts)?$/i,
    ],
  },
  {
    platform: "ios",
    matchers: [
      /\.xcodeproj(\/|$)/i,
      /\.xcworkspace(\/|$)/i,
      /(^|\/)Podfile$/i,
      /(^|\/)Package\.swift$/i,
      /\.swift$/i,
      /\.xib$/i,
    ],
  },
  {
    platform: "web",
    matchers: [
      /(^|\/)package\.json$/i,
      /(^|\/)next\.config\.(js|ts|mjs)$/i,
      /(^|\/)vite\.config\.(js|ts|mjs)$/i,
      /(^|\/)angular\.json$/i,
      /(^|\/)nuxt\.config\.(js|ts|mjs)$/i,
      /(^|\/)svelte\.config\.(js|ts)$/i,
      /(^|\/)remix\.config\.(js|ts)$/i,
    ],
  },
];

// Files we excerpt into the prompt context.
// Order matters slightly: README first for general signal, then platform
// fingerprint files. Limit per-file size handled in fetchKeyFiles below.
const KEY_FILE_CANDIDATES = [
  "README.md",
  "README.rst",
  "readme.md",
  "package.json",
  // iOS
  "Info.plist",
  "project.pbxproj", // matches anything ending in /<name>.xcodeproj/project.pbxproj
  "Package.swift",
  "Podfile",
  // Android
  "AndroidManifest.xml",
  "build.gradle",
  "build.gradle.kts",
  // React Native / Expo
  "app.config.js",
  "app.json",
];

// Files where we want a larger excerpt because the data we care about
// (PRODUCT_BUNDLE_IDENTIFIER, CFBundleIdentifier) is sometimes deep in the file.
const LARGER_EXCERPT_FILES = new Set(["project.pbxproj"]);

export class GitHubRestProvider implements GitHubProvider {
  readonly name = "github-rest";
  private readonly token: string;

  constructor(creds: GitHubCredentials) {
    this.token = creds.pat;
  }

  private async req<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${GH_API}${path}`, {
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${this.token}`,
        "x-github-api-version": "2022-11-28",
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GitHub ${res.status}: ${text.slice(0, 500)}`);
    }
    // Some PUT/PATCH responses can be empty
    const text = await res.text();
    if (!text) return undefined as unknown as T;
    return JSON.parse(text) as T;
  }

  async ping() {
    try {
      const me = await this.req<{ login: string }>("/user");
      return { ok: true as const, login: me.login };
    } catch (e) {
      return { ok: false as const, error: (e as Error).message };
    }
  }

  async listRepos({ limit = 50 }: { limit?: number } = {}): Promise<GitHubRepoSummary[]> {
    const data = await this.req<
      Array<{
        full_name: string;
        owner: { login: string };
        name: string;
        default_branch: string;
        private: boolean;
        language: string | null;
        description: string | null;
        updated_at: string;
        stargazers_count: number;
      }>
    >(`/user/repos?per_page=${Math.min(limit, 100)}&sort=updated&affiliation=owner,collaborator`);
    return data.map((r) => ({
      full_name: r.full_name,
      owner: r.owner.login,
      name: r.name,
      default_branch: r.default_branch,
      private: r.private,
      language: r.language ?? undefined,
      description: r.description ?? undefined,
      updated_at: r.updated_at,
      stargazers_count: r.stargazers_count,
    }));
  }

  detectPlatforms(filePaths: string[]): Platform[] {
    const found = new Set<Platform>();
    for (const fp of PLATFORM_FINGERPRINTS) {
      for (const path of filePaths) {
        if (fp.matchers.some((m) => m.test(path))) {
          found.add(fp.platform);
          break;
        }
      }
    }
    return Array.from(found);
  }

  async buildContext(owner: string, repo: string): Promise<RepoContext> {
    // 1. Repo metadata + default branch
    const meta = await this.req<{
      default_branch: string;
      language: string | null;
    }>(`/repos/${owner}/${repo}`);

    // 2. Language breakdown
    let language_breakdown: Record<string, number> | undefined;
    try {
      language_breakdown = await this.req<Record<string, number>>(
        `/repos/${owner}/${repo}/languages`,
      );
    } catch {
      // ignore — not fatal
    }

    // 3. File tree (recursive, truncated by GitHub at ~100k entries)
    const tree = await this.req<{
      tree: Array<{ path: string; type: string; size?: number }>;
      truncated: boolean;
    }>(`/repos/${owner}/${repo}/git/trees/${meta.default_branch}?recursive=1`);

    const paths = tree.tree.filter((t) => t.type === "blob").map((t) => t.path);
    const detected_platforms = this.detectPlatforms(paths);

    // 4. README excerpt
    let readme_excerpt = "";
    try {
      const readme = await this.req<{ content: string; encoding: string }>(
        `/repos/${owner}/${repo}/readme`,
      );
      readme_excerpt = decodeBase64(readme.content).slice(0, 6000);
    } catch {
      // no README — fine
    }

    // 5. Key files (only the ones that actually exist)
    const key_files = await this.fetchKeyFiles(owner, repo, paths);

    // 6. File tree sample — keep it scannable for the LLM
    const file_tree_sample = sampleFileTree(paths, 80);

    return {
      owner,
      repo,
      default_branch: meta.default_branch,
      detected_platforms,
      language_breakdown,
      readme_excerpt,
      file_tree_sample,
      key_files,
    };
  }

  // ────────────────────────────────────────────────────────────────────────
  // Phase 11.7 — repo creation + file commit + PR
  // ────────────────────────────────────────────────────────────────────────

  /** Returns true if the repo exists, false otherwise. */
  async repoExists(owner: string, repo: string): Promise<boolean> {
    try {
      await this.req(`/repos/${owner}/${repo}`);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Create a new repo under the authenticated user (or under an org if owner
   * matches the user's orgs). Returns the new repo's metadata.
   */
  async createRepo(opts: {
    name: string;
    description?: string;
    private?: boolean;
    org?: string;
  }): Promise<{ full_name: string; default_branch: string; html_url: string }> {
    const path = opts.org ? `/orgs/${opts.org}/repos` : `/user/repos`;
    return this.req(path, {
      method: "POST",
      body: JSON.stringify({
        name: opts.name,
        description: opts.description ?? "E2E tests — generated by jiraqa.com",
        private: opts.private ?? true,
        auto_init: true,
      }),
    });
  }

  /** Get the SHA for a branch's HEAD. */
  async getBranchSha(owner: string, repo: string, branch: string): Promise<string> {
    const data = await this.req<{ object: { sha: string } }>(
      `/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`,
    );
    return data.object.sha;
  }

  /** Create a new branch from a base SHA. */
  async createBranch(
    owner: string,
    repo: string,
    branch: string,
    fromSha: string,
  ): Promise<void> {
    await this.req(`/repos/${owner}/${repo}/git/refs`, {
      method: "POST",
      body: JSON.stringify({
        ref: `refs/heads/${branch}`,
        sha: fromSha,
      }),
    });
  }

  /**
   * Create or update a single file on a branch via the contents API.
   * For multi-file commits we call this per file — fine for our scale
   * (typically 5-8 files per scaffold PR).
   */
  async putFile(opts: {
    owner: string;
    repo: string;
    branch: string;
    path: string;
    content: string;
    message: string;
  }): Promise<void> {
    const encoded =
      typeof Buffer !== "undefined"
        ? Buffer.from(opts.content, "utf-8").toString("base64")
        : btoa(unescape(encodeURIComponent(opts.content)));

    // Check if the file already exists on the branch — if so we need its SHA.
    let sha: string | undefined;
    try {
      const existing = await this.req<{ sha: string }>(
        `/repos/${opts.owner}/${opts.repo}/contents/${encodeURIComponent(opts.path)}?ref=${opts.branch}`,
      );
      sha = existing.sha;
    } catch {
      // file doesn't exist yet — that's fine, we're creating it
    }

    await this.req(`/repos/${opts.owner}/${opts.repo}/contents/${opts.path}`, {
      method: "PUT",
      body: JSON.stringify({
        message: opts.message,
        content: encoded,
        branch: opts.branch,
        ...(sha ? { sha } : {}),
      }),
    });
  }

  /** Open a pull request. */
  async openPullRequest(opts: {
    owner: string;
    repo: string;
    title: string;
    body: string;
    head: string; // branch
    base: string; // usually "main"
  }): Promise<{ html_url: string; number: number }> {
    return this.req(`/repos/${opts.owner}/${opts.repo}/pulls`, {
      method: "POST",
      body: JSON.stringify({
        title: opts.title,
        body: opts.body,
        head: opts.head,
        base: opts.base,
      }),
    });
  }

  /**
   * List branches in a repo, optionally filtered by name prefix.
   * Used by staleness detection to find pending jiraqa/* PR branches.
   */
  async listBranches(opts: {
    owner: string;
    repo: string;
    prefix?: string;
  }): Promise<Array<{ name: string; sha: string }>> {
    try {
      const data = await this.req<
        Array<{ name: string; commit: { sha: string } }>
      >(`/repos/${opts.owner}/${opts.repo}/branches?per_page=100`);
      const all = data.map((b) => ({ name: b.name, sha: b.commit.sha }));
      return opts.prefix
        ? all.filter((b) => b.name.startsWith(opts.prefix!))
        : all;
    } catch {
      return [];
    }
  }

  /**
   * List the names of files in a directory at a branch. Returns empty
   * array if the directory doesn't exist. Used by staleness detection
   * to enumerate generated test flows in an e2e repo.
   */
  async listDirectory(opts: {
    owner: string;
    repo: string;
    branch: string;
    path: string;
  }): Promise<Array<{ name: string; path: string; type: string }>> {
    try {
      const data = await this.req<
        Array<{ name: string; path: string; type: string }>
      >(
        `/repos/${opts.owner}/${opts.repo}/contents/${encodeURIComponent(opts.path)}?ref=${opts.branch}`,
      );
      return Array.isArray(data) ? data : [];
    } catch {
      return [];
    }
  }

  /**
   * Get the decoded content of a file on a given branch. Returns null
   * if the file doesn't exist on that branch. Used by the regeneration
   * flow to detect whether a file has been hand-edited since we last
   * generated it.
   */
  async getFileContent(opts: {
    owner: string;
    repo: string;
    branch: string;
    path: string;
  }): Promise<string | null> {
    try {
      const file = await this.req<{ content: string; encoding: string }>(
        `/repos/${opts.owner}/${opts.repo}/contents/${encodeURIComponent(opts.path)}?ref=${opts.branch}`,
      );
      return decodeBase64(file.content);
    } catch {
      return null;
    }
  }

  /**
   * Find an existing OPEN pull request for a given branch. Used when
   * openPullRequest returns 422 ("PR already exists") to surface the existing
   * URL instead of failing.
   */
  async findOpenPullRequest(opts: {
    owner: string;
    repo: string;
    head: string; // "<user>:<branch>" or just "<branch>"
  }): Promise<{ html_url: string; number: number } | null> {
    const headParam = opts.head.includes(":")
      ? opts.head
      : `${opts.owner}:${opts.head}`;
    try {
      const data = await this.req<
        Array<{ html_url: string; number: number; head: { ref: string } }>
      >(
        `/repos/${opts.owner}/${opts.repo}/pulls?state=open&head=${encodeURIComponent(headParam)}`,
      );
      if (data.length === 0) return null;
      return { html_url: data[0]!.html_url, number: data[0]!.number };
    } catch {
      return null;
    }
  }

  private async fetchKeyFiles(
    owner: string,
    repo: string,
    paths: string[],
  ): Promise<RepoContext["key_files"]> {
    const out: NonNullable<RepoContext["key_files"]> = [];
    for (const candidate of KEY_FILE_CANDIDATES) {
      const path = paths.find(
        (p) => p === candidate || p.toLowerCase().endsWith(`/${candidate.toLowerCase()}`),
      );
      if (!path) continue;
      try {
        const file = await this.req<{ content: string; encoding: string }>(
          `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`,
        );
        const decoded = decodeBase64(file.content);
        // .pbxproj files are huge but the bundle id usually appears multiple
        // times — keep more of the file so detection can find it.
        const limit = LARGER_EXCERPT_FILES.has(candidate) ? 20000 : 2000;
        out.push({ path, excerpt: decoded.slice(0, limit) });
        if (out.length >= 8) break;
      } catch {
        // ignore individual file failures
      }
    }
    return out;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function decodeBase64(s: string): string {
  // GitHub wraps base64 with newlines.
  const clean = s.replace(/\s+/g, "");
  if (typeof Buffer !== "undefined") return Buffer.from(clean, "base64").toString("utf-8");
  // Edge runtime fallback
  return atob(clean);
}

/**
 * Take a representative sample of paths weighted toward shallow files
 * (so the LLM gets a high-level map of the repo, not a deep dive).
 */
function sampleFileTree(paths: string[], limit: number): string[] {
  const sorted = [...paths].sort((a, b) => a.split("/").length - b.split("/").length);
  return sorted.slice(0, limit);
}
