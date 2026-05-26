/**
 * @module @jiraqa/core/types
 * Shared domain types used across web app, providers, and Python sidecar (via OpenAPI).
 */

import { z } from "zod";

// ────────────────────────────────────────────────────────────────────────────
// Platform
// ────────────────────────────────────────────────────────────────────────────

export const PlatformSchema = z.enum(["android", "ios", "web"]);
export type Platform = z.infer<typeof PlatformSchema>;

// ────────────────────────────────────────────────────────────────────────────
// Jira ticket — same surface area as v1 plus optional repo context fields.
// ────────────────────────────────────────────────────────────────────────────

export const JiraTicketSchema = z.object({
  ticket_id: z.string().min(1),
  summary: z.string().min(1),
  description: z.string().optional().default(""),
  acceptance_criteria: z.array(z.string()).optional().default([]),
  issue_type: z
    .enum(["story", "bug", "task", "epic", "subtask"])
    .optional()
    .default("story"),
  priority: z.enum(["low", "medium", "high", "critical"]).optional().default("medium"),
  component: z.string().optional().default(""),
  labels: z.array(z.string()).optional().default([]),
  environment: z.string().optional().default(""),
});
export type JiraTicket = z.infer<typeof JiraTicketSchema>;

// ────────────────────────────────────────────────────────────────────────────
// Repo context — curated snippet of the GitHub repo for the prompt.
// ────────────────────────────────────────────────────────────────────────────

export const RepoContextSchema = z.object({
  owner: z.string(),
  repo: z.string(),
  default_branch: z.string().optional().default("main"),
  detected_platforms: z.array(PlatformSchema).default([]),
  language_breakdown: z.record(z.number()).optional(),
  readme_excerpt: z.string().optional().default(""),
  file_tree_sample: z.array(z.string()).optional().default([]),
  key_files: z
    .array(
      z.object({
        path: z.string(),
        excerpt: z.string(),
      }),
    )
    .optional()
    .default([]),
});
export type RepoContext = z.infer<typeof RepoContextSchema>;

// ────────────────────────────────────────────────────────────────────────────
// Test case
// ────────────────────────────────────────────────────────────────────────────

export const TestCaseSchema = z.object({
  test_case_id: z.string(),
  test_scenario: z.string(),
  platform: PlatformSchema,
  preconditions: z.array(z.string()).default([]),
  test_steps: z.array(z.string()).default([]),
  test_data: z.array(z.string()).default([]),
  expected_result: z.string(),
  priority: z.enum(["low", "medium", "high", "critical"]).nullable().default("medium"),
  automation_candidate: z.boolean().default(true),
  automation_framework_hint: z.string().optional(),
  tags: z.array(z.string()).default([]),
});
export type TestCase = z.infer<typeof TestCaseSchema>;

// ────────────────────────────────────────────────────────────────────────────
// Generate request / response
// ────────────────────────────────────────────────────────────────────────────

/**
 * A screenshot attached to a generation request. Data URL only — the same
 * format the LLM providers consume. Validation caps both individual size
 * (5 MB encoded) and total count (3) at the API layer.
 */
export const ScreenshotSchema = z.object({
  data_url: z
    .string()
    .regex(/^data:image\/(png|jpeg|jpg|webp|gif);base64,/, {
      message: "Must be a base64 image data URL (png/jpeg/webp/gif).",
    }),
  label: z.string().max(200).optional(),
});
export type Screenshot = z.infer<typeof ScreenshotSchema>;

export const GenerateRequestSchema = z.object({
  ticket: JiraTicketSchema,
  platform: PlatformSchema,
  repo_context: RepoContextSchema.optional(),
  provider: z.enum(["openai", "gemini", "anthropic"]).optional(),
  count_hint: z.number().int().min(3).max(8).optional().default(5),
  /** Phase 12 — optional screenshots. Triggers vision-LLM routing. */
  screenshots: z.array(ScreenshotSchema).max(3).optional(),
});
export type GenerateRequest = z.infer<typeof GenerateRequestSchema>;

export const GenerateResponseSchema = z
  .object({
    ticket_id: z.string(),
    summary: z.string(),
    platform: PlatformSchema,
    provider: z.string(),
    backend: z.enum(["typescript", "python"]),
    generated_test_cases: z.array(TestCaseSchema),
  })
  .superRefine((data, ctx) => {
    const n = data.generated_test_cases.length;
    if (n < 3 || n > 8) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Expected 3-8 test cases, got ${n}`,
      });
    }
  });
export type GenerateResponse = z.infer<typeof GenerateResponseSchema>;

// ────────────────────────────────────────────────────────────────────────────
// Error
// ────────────────────────────────────────────────────────────────────────────

export const ErrorResponseSchema = z.object({
  error: z.string(),
  details: z.string().optional(),
  code: z.string().optional(),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

// ────────────────────────────────────────────────────────────────────────────
// Session / connections — what we persist in the encrypted cookie.
// Tenant-scoped shape so we can swap in a real DB later for SaaS.
// ────────────────────────────────────────────────────────────────────────────

export interface JiraConnection {
  site_url: string; // e.g. acme.atlassian.net
  email: string;
  api_token: string;
}

export interface GitHubConnection {
  pat: string; // fine-grained personal access token
  login?: string; // resolved username (cached after first /api/connections/test)
}

export interface SessionData {
  // For v1, the "tenant" is just the browser session.
  // For SaaS v2, this becomes user_id linked to a DB row.
  tenant_id?: string;
  jira?: JiraConnection;
  github?: GitHubConnection;
  preferred_provider?: "openai" | "gemini" | "anthropic";
  preferred_backend?: "typescript" | "python";
  // Phase 11: per-repo E2E test conventions. Keyed by "<owner>/<repo>"
  // so a user with multiple connected repos can configure each independently.
  repo_conventions?: Record<string, RepoConventions>;
}

// ────────────────────────────────────────────────────────────────────────────
// Phase 11 — E2E test conventions per repo.
// Tenant-scoped storage means each user's preferences ride with their cookie.
// ────────────────────────────────────────────────────────────────────────────

export const TestFormatSchema = z.enum(["maestro", "xcuitest", "espresso"]);
export type TestFormat = z.infer<typeof TestFormatSchema>;

export const CiPlatformSchema = z.enum([
  "github_actions",
  "circleci",
  "both",
  "none",
]);
export type CiPlatform = z.infer<typeof CiPlatformSchema>;

export const ExecutionBackendSchema = z.enum([
  "local", // simulator/emulator on the user's machine
  "github_actions", // macOS / Linux runners
  "maestro_cloud", // mobile.dev paid
  "firebase_test_lab", // Google
  "browserstack", // paid
  "saucelabs", // paid
  "lambdatest", // paid
]);
export type ExecutionBackend = z.infer<typeof ExecutionBackendSchema>;

export const RepoConventionsSchema = z.object({
  // Which platform these conventions apply to.
  platform: PlatformSchema,

  // ── Test format ────────────────────────────────────────────────────────
  // Default Maestro (YAML, easy, separate-repo, zero risk).
  // XCUITest = Swift, iOS power users.
  // Espresso = Kotlin, Android power users.
  test_format: TestFormatSchema.default("maestro"),

  // ── E2E repo strategy ──────────────────────────────────────────────────
  // For Maestro: always "separate" — one repo per platform (user's call).
  // For XCUITest/Espresso: "separate" (recommended, zero risk) or
  // "same" (lives inside the main app project — requires safety net).
  repo_strategy: z.enum(["separate", "same"]).default("separate"),

  // The target e2e repo name. If omitted we propose `<app>-ios-e2e` /
  // `<app>-android-e2e` and create it during the first PR.
  e2e_repo_name: z.string().optional(),

  // ── CI ─────────────────────────────────────────────────────────────────
  ci_platform: CiPlatformSchema.default("github_actions"),
  use_fastlane: z.boolean().default(true),

  // ── Execution backend (where tests actually run) ───────────────────────
  execution_backend: ExecutionBackendSchema.default("local"),

  // ── iOS-specific ───────────────────────────────────────────────────────
  ios_bundle_id: z.string().optional(), // auto-detected
  ios_deployment_target: z.string().optional(), // e.g. "17.0"
  ios_dependency_manager: z
    .enum(["spm", "cocoapods", "carthage", "tuist", "xcodegen"])
    .optional(),
  // For separate-repo XCUITest: simulator-only by default (no Apple Dev acct).
  ios_signing_mode: z.enum(["simulator_only", "device"]).default("simulator_only"),

  // ── Android-specific ───────────────────────────────────────────────────
  android_application_id: z.string().optional(), // e.g. "com.acme.app"
  android_min_sdk: z.number().int().optional(),

  // ── Patterns ───────────────────────────────────────────────────────────
  use_robot_pattern: z.boolean().default(true), // Robot / Page Object
  selector_strategy: z
    .enum(["accessibility_id", "label_text", "hybrid"])
    .default("accessibility_id"),

  // ── Metadata ───────────────────────────────────────────────────────────
  detected_at: z.string().optional(), // ISO timestamp of last auto-detect
  saved_at: z.string().optional(),
});
export type RepoConventions = z.infer<typeof RepoConventionsSchema>;
