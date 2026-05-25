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
const KEY_FILE_CANDIDATES = [
  "README.md",
  "README.rst",
  "readme.md",
  "package.json",
  "AndroidManifest.xml",
  "build.gradle",
  "build.gradle.kts",
  "Package.swift",
  "Podfile",
  "app.config.js",
  "app.json",
];

export class GitHubRestProvider implements GitHubProvider {
  readonly name = "github-rest";
  private readonly token: string;

  constructor(creds: GitHubCredentials) {
    this.token = creds.pat;
  }

  private async req<T>(path: string): Promise<T> {
    const res = await fetch(`${GH_API}${path}`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${this.token}`,
        "x-github-api-version": "2022-11-28",
      },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GitHub ${res.status}: ${text.slice(0, 500)}`);
    }
    return (await res.json()) as T;
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
        out.push({ path, excerpt: decodeBase64(file.content).slice(0, 2000) });
        if (out.length >= 6) break;
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
