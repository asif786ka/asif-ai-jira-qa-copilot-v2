/**
 * @module @jiraqa/core/marker
 *
 * Phase 13.1 — every file we generate carries a marker line near the top
 * so future regenerations can tell:
 *   • this file is still our auto-generated version → safe to overwrite
 *   • this file has been hand-edited (marker missing/altered) → preserve it
 *
 * Phase 13.2 Tier 1 — the marker also embeds the main repo HEAD SHA we
 * generated against, so we can detect staleness when the main repo has
 * moved forward.
 *
 * The marker uses a stable prefix so detection is a simple substring check.
 */

export const MARKER_PREFIX = "jiraqa: generated";
export const MARKER_VERSION = "v1";

export interface MarkerInfo {
  version: string;
  /** "<owner>/<repo>" of the main app this test was generated against. */
  source_repo?: string;
  /** Main repo HEAD SHA at generation time. Empty when unknown. */
  source_sha?: string;
  /** Jira ticket id (or CUSTOM-* id) the test was generated for. */
  ticket_id?: string;
  /** ISO timestamp of generation. */
  generated_at?: string;
}

/**
 * Build the marker comment line. Caller picks the comment prefix based on
 * the target file format ("#" for YAML/Ruby, "//" for Swift/Kotlin/TS).
 */
export function buildMarkerLine(
  commentPrefix: string,
  info: MarkerInfo,
): string {
  const parts = [`${MARKER_PREFIX} ${info.version}`];
  if (info.source_repo)
    parts.push(`source ${info.source_repo}${info.source_sha ? `@${info.source_sha.slice(0, 7)}` : ""}`);
  if (info.ticket_id) parts.push(`ticket ${info.ticket_id}`);
  if (info.generated_at) parts.push(`at ${info.generated_at}`);
  parts.push("do not edit this line to keep regeneration safe");
  return `${commentPrefix} ${parts.join(" · ")}`;
}

/** Extract marker info from file content, or null if not present. */
export function parseMarker(content: string): MarkerInfo | null {
  // Look for "jiraqa: generated vN" anywhere on a line — robust to either
  // "#" or "//" comment prefix.
  const lines = content.split("\n").slice(0, 5); // marker is always near the top
  for (const line of lines) {
    const idx = line.indexOf(MARKER_PREFIX);
    if (idx < 0) continue;
    const tail = line.slice(idx + MARKER_PREFIX.length).trim();
    // Tail starts with "vN · part1 · part2 · ..."
    const segments = tail.split("·").map((s) => s.trim());
    const versionToken = segments.shift() ?? "";
    const out: MarkerInfo = { version: versionToken };
    for (const seg of segments) {
      if (seg.startsWith("source ")) {
        const rest = seg.slice("source ".length);
        const at = rest.indexOf("@");
        out.source_repo = at >= 0 ? rest.slice(0, at) : rest;
        if (at >= 0) out.source_sha = rest.slice(at + 1);
      } else if (seg.startsWith("ticket ")) {
        out.ticket_id = seg.slice("ticket ".length);
      } else if (seg.startsWith("at ")) {
        out.generated_at = seg.slice("at ".length);
      }
    }
    return out;
  }
  return null;
}

/** Pick the comment prefix for a given file path. */
export function commentPrefixFor(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".swift")) return "//";
  if (lower.endsWith(".kt") || lower.endsWith(".kts")) return "//";
  if (lower.endsWith(".ts") || lower.endsWith(".tsx") || lower.endsWith(".js"))
    return "//";
  if (lower.endsWith(".java")) return "//";
  // Everything else (.yaml, .yml, Fastfile, Gemfile, Appfile, .md, .gitignore)
  // uses # — that covers our scaffolding.
  return "#";
}

/**
 * Prepend the marker line to file content. Returns content + a newline +
 * the original. Idempotent — if the file already has a marker, we
 * REPLACE the existing line in-place rather than stacking duplicates.
 */
export function applyMarker(
  content: string,
  path: string,
  info: MarkerInfo,
): string {
  const prefix = commentPrefixFor(path);
  const newLine = buildMarkerLine(prefix, info);

  // If there's already a marker line near the top, replace it in-place.
  const lines = content.split("\n");
  for (let i = 0; i < Math.min(lines.length, 5); i++) {
    if (lines[i]!.includes(MARKER_PREFIX)) {
      lines[i] = newLine;
      return lines.join("\n");
    }
  }

  // Otherwise prepend (after a leading shebang or YAML directive if present).
  if (lines[0]?.startsWith("#!")) {
    return [lines[0], newLine, ...lines.slice(1)].join("\n");
  }
  return [newLine, ...lines].join("\n");
}
