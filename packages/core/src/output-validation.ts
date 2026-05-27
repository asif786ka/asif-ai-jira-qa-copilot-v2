/**
 * @module @jiraqa/core/output-validation
 *
 * TypeScript mirror of apps/api-python/api/output_validation.py.
 *
 * Lints LLM-generated TestCase[] for content quality (atomicity, measurability,
 * coverage, sanity). Returns the same TicketValidationIssue shape as the input
 * validator so the UI panel can render either source.
 *
 * Keep this file in lockstep with the Python version — both backends must
 * produce identical issue codes for the same input.
 */

import type { Platform, TestCase } from "./types";
import type { TicketValidationIssue } from "./validation";

// ────────────────────────────────────────────────────────────────────────────
// Tunables (keep in sync with Python)
// ────────────────────────────────────────────────────────────────────────────

export const TC_ID_RE = /^TC-\d{3,}$/;

const DEAD_PHRASES = [
  "it works",
  "works fine",
  "works correctly",
  "as expected",
  "no issues",
  "no problems",
  "behaves correctly",
  "function correctly",
  "functions correctly",
  "works as intended",
] as const;
const DEAD_RE = new RegExp(
  `\\b(${DEAD_PHRASES.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`,
  "i",
);
const ASSERTION_VERB_RE =
  /\b(appears?|shows?|displays?|equals?|contains?|returns?|matches?|opens?|navigates?|redirects?|increments?|decrements?|is (visible|hidden|enabled|disabled|selected|focused|present|absent)|updates? to|reflects?|persists?|loads?|reads?)\b/i;
const NUMBER_OR_QUOTE_RE = /(\d+(?:\.\d+)?|"[^"]+"|'[^']+'|\$\d|%)/;
const AND_JOIN_RE = /\s+\band\b\s+(?!the)/i;
const THEN_JOIN_RE = /\s+\bthen\b\s+/i;

export const HAPPY_TAGS = new Set([
  "happy-path",
  "happy_path",
  "happypath",
  "positive",
  "smoke",
]);
export const NEGATIVE_TAGS = new Set([
  "negative",
  "invalid",
  "validation",
  "error",
  "failure",
]);
export const EDGE_TAGS = new Set([
  "edge",
  "edge-case",
  "boundary",
  "limit",
  "performance",
  "race",
]);

const ALLOWED_FRAMEWORKS: Record<Platform, Set<string>> = {
  android: new Set([
    "espresso",
    "ui automator",
    "uiautomator",
    "maestro",
    "appium",
    "compose ui test",
    "compose test",
  ]),
  ios: new Set(["xcuitest", "xctest", "maestro", "appium", "earlgrey"]),
  web: new Set([
    "playwright",
    "cypress",
    "selenium",
    "webdriverio",
    "puppeteer",
    "testcafe",
  ]),
};

// ────────────────────────────────────────────────────────────────────────────
// Rules
// ────────────────────────────────────────────────────────────────────────────

function r1UniqueIds(cases: TestCase[]): TicketValidationIssue[] {
  const issues: TicketValidationIssue[] = [];
  const seen = new Map<string, number>();
  cases.forEach((tc, i) => {
    if (!TC_ID_RE.test(tc.test_case_id ?? "")) {
      issues.push({
        field: `generated_test_cases[${i}].test_case_id`,
        code: "tc_id_format",
        severity: "error",
        message: `test_case_id '${tc.test_case_id}' does not match TC-### pattern.`,
        hint: "Use TC-001, TC-002, etc.",
      });
    }
    seen.set(tc.test_case_id, (seen.get(tc.test_case_id) ?? 0) + 1);
  });
  for (const [id, count] of seen.entries()) {
    if (count > 1) {
      issues.push({
        field: "generated_test_cases",
        code: "tc_id_duplicate",
        severity: "error",
        message: `test_case_id '${id}' appears ${count} times.`,
        hint: "Every case must have a unique ID.",
      });
    }
  }
  return issues;
}

function r2AtomicSteps(cases: TestCase[]): TicketValidationIssue[] {
  const issues: TicketValidationIssue[] = [];
  cases.forEach((tc, i) => {
    tc.test_steps.forEach((step, j) => {
      const text = (step ?? "").trim();
      if (AND_JOIN_RE.test(text) || THEN_JOIN_RE.test(text)) {
        issues.push({
          field: `generated_test_cases[${i}].test_steps[${j}]`,
          code: "step_not_atomic",
          severity: "error",
          message: `Step '${text.slice(0, 80)}...' looks like two actions.`,
          hint: "Split into one step per user action.",
        });
      }
    });
  });
  return issues;
}

function r3MeasurableExpected(cases: TestCase[]): TicketValidationIssue[] {
  const issues: TicketValidationIssue[] = [];
  cases.forEach((tc, i) => {
    const text = (tc.expected_result ?? "").trim();
    if (!text) {
      issues.push({
        field: `generated_test_cases[${i}].expected_result`,
        code: "expected_missing",
        severity: "error",
        message: "expected_result is empty.",
        hint: "State what the user / system should observe after the steps.",
      });
      return;
    }
    const dead = text.match(DEAD_RE);
    if (dead) {
      issues.push({
        field: `generated_test_cases[${i}].expected_result`,
        code: "expected_vague",
        severity: "error",
        message: `expected_result contains vague phrase '${dead[1]}'.`,
        hint: "Replace with a measurable outcome (specific UI text, number, screen).",
      });
    }
    const hasSpecificity =
      NUMBER_OR_QUOTE_RE.test(text) || ASSERTION_VERB_RE.test(text);
    if (!hasSpecificity) {
      issues.push({
        field: `generated_test_cases[${i}].expected_result`,
        code: "expected_not_specific",
        severity: "error",
        message: `expected_result '${text.slice(0, 80)}' has no concrete assertion.`,
        hint: "Use an assertion verb (appears/shows/equals) or a specific value.",
      });
    }
  });
  return issues;
}

function r4Coverage(cases: TestCase[]): TicketValidationIssue[] {
  const issues: TicketValidationIssue[] = [];
  const allTags = new Set<string>();
  for (const tc of cases) {
    for (const t of tc.tags ?? []) allTags.add((t ?? "").trim().toLowerCase());
  }
  const has = (set: Set<string>) => [...allTags].some((t) => set.has(t));
  if (!has(HAPPY_TAGS)) {
    issues.push({
      field: "generated_test_cases",
      code: "coverage_missing_happy_path",
      severity: "error",
      message: "Batch has no happy-path / positive / smoke test case.",
      hint: "Add at least one positive scenario tagged 'happy-path' or 'positive'.",
    });
  }
  if (!has(NEGATIVE_TAGS)) {
    issues.push({
      field: "generated_test_cases",
      code: "coverage_missing_negative",
      severity: "error",
      message: "Batch has no negative / validation / error case.",
      hint: "Add at least one negative scenario tagged 'negative' or 'validation'.",
    });
  }
  if (!has(EDGE_TAGS)) {
    issues.push({
      field: "generated_test_cases",
      code: "coverage_missing_edge",
      severity: "warning",
      message: "Batch has no edge / boundary case.",
      hint: "Consider adding a 'boundary' or 'edge' tagged case if relevant.",
    });
  }
  return issues;
}

function r5Sanity(cases: TestCase[], platform: Platform): TicketValidationIssue[] {
  const issues: TicketValidationIssue[] = [];
  const allowed = ALLOWED_FRAMEWORKS[platform] ?? new Set<string>();
  cases.forEach((tc, i) => {
    if (tc.test_steps.length < 2) {
      issues.push({
        field: `generated_test_cases[${i}].test_steps`,
        code: "too_few_steps",
        severity: "error",
        message: `Case '${tc.test_case_id}' has only ${tc.test_steps.length} step(s).`,
        hint: "A meaningful test usually has at least 2 steps.",
      });
    }
    if (!tc.preconditions || tc.preconditions.length === 0) {
      issues.push({
        field: `generated_test_cases[${i}].preconditions`,
        code: "missing_preconditions",
        severity: "warning",
        message: `Case '${tc.test_case_id}' has no preconditions.`,
        hint: "Specify the starting state ('User is logged in', 'On Home screen').",
      });
    }
    if (allowed.size > 0 && tc.automation_framework_hint) {
      const hintNorm = tc.automation_framework_hint.trim().toLowerCase();
      const ok = [...allowed].some((a) => hintNorm.includes(a));
      if (!ok) {
        issues.push({
          field: `generated_test_cases[${i}].automation_framework_hint`,
          code: "framework_mismatch",
          severity: "warning",
          message: `automation_framework_hint '${tc.automation_framework_hint}' is not a typical ${platform} framework.`,
          hint: `For ${platform}, prefer: ${[...allowed].sort().join(", ")}.`,
        });
      }
    }
  });
  return issues;
}

// ────────────────────────────────────────────────────────────────────────────
// Public entry point
// ────────────────────────────────────────────────────────────────────────────

export function lintGeneratedCases(
  cases: TestCase[],
  platform: Platform,
): TicketValidationIssue[] {
  return [
    ...r1UniqueIds(cases),
    ...r2AtomicSteps(cases),
    ...r3MeasurableExpected(cases),
    ...r4Coverage(cases),
    ...r5Sanity(cases, platform),
  ];
}

export function errorsOnly(issues: TicketValidationIssue[]): TicketValidationIssue[] {
  return issues.filter((i) => i.severity === "error");
}
