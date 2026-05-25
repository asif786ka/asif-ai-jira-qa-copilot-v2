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

export const GenerateRequestSchema = z.object({
  ticket: JiraTicketSchema,
  platform: PlatformSchema,
  repo_context: RepoContextSchema.optional(),
  provider: z.enum(["openai", "gemini"]).optional(),
  count_hint: z.number().int().min(3).max(8).optional().default(5),
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
  preferred_provider?: "openai" | "gemini";
  preferred_backend?: "typescript" | "python";
}
