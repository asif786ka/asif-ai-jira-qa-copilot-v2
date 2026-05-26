/**
 * @module @jiraqa/core/prompts/code
 *
 * Stage-2 prompts: turn an array of TestCase objects into executable test code.
 * Output formats supported:
 *   - Maestro YAML   (cross-platform, YAML-based, default for Maestro path)
 *   - XCUITest Swift (iOS, full programmatic power)
 *   - Espresso Kotlin (Android, full programmatic power)
 *
 * Each generator is a pure function (testCases, conventions) → prompt strings.
 * We send these to an LLM and expect a single file's content back.
 */

import type { JiraTicket, RepoConventions, TestCase } from "../types";

// ────────────────────────────────────────────────────────────────────────────
// Maestro YAML
// ────────────────────────────────────────────────────────────────────────────

export function buildMaestroSystemPrompt(conventions: RepoConventions): string {
  const platform = conventions.platform;
  const targetId =
    platform === "ios"
      ? conventions.ios_bundle_id ?? "com.acme.app"
      : conventions.android_application_id ?? "com.acme.app";

  return `You are a senior QA engineer producing Maestro test flows.

Maestro is a YAML-based mobile UI test framework (https://maestro.mobile.dev).
Output must be VALID Maestro YAML — one flow per file.

PLATFORM: ${platform}
TARGET APP: ${targetId}

MAESTRO RULES
1. The first line of every flow is "appId: ${targetId}".
2. Commands available (use only these): launchApp, tapOn, inputText, scroll,
   scrollUntilVisible, swipe, back, assertVisible, assertNotVisible,
   waitForAnimationToEnd, clearState, clearKeychain, pressKey, hideKeyboard,
   takeScreenshot, copyTextFrom, repeat, runScript, runFlow.
3. Prefer "tapOn:" with a string label for normal taps. Use
   "tapOn: { id: <accessibility-id> }" when conventions specify
   selector_strategy = "accessibility_id" (which is the default).
4. Use "assertVisible" rather than "waitForElementToHaveText". Maestro
   auto-waits on every assertion.
5. Add a clear comment "# <test scenario name>" at the top of each test step
   block to map back to the JiraTicket scenario.
6. NEVER invent commands not in the list above.

OUTPUT
Return ONLY raw YAML. No prose, no markdown fences, no commentary.
If multiple test cases are provided, generate one consolidated flow file
that runs all of them in sequence with clear "# --- TC-XXX ---" markers.`;
}

export function buildMaestroUserPrompt(
  ticket: JiraTicket,
  testCases: TestCase[],
): string {
  const lines: string[] = [];
  lines.push(`# JIRA TICKET ${ticket.ticket_id} — ${ticket.summary}`);
  if (ticket.description) lines.push(`Description: ${ticket.description}`);
  lines.push("");
  lines.push("# TEST CASES TO IMPLEMENT");
  for (const tc of testCases) {
    lines.push(`## ${tc.test_case_id} — ${tc.test_scenario}`);
    if (tc.preconditions?.length) {
      lines.push(`Preconditions: ${tc.preconditions.join("; ")}`);
    }
    lines.push("Steps:");
    tc.test_steps.forEach((s, i) => lines.push(`  ${i + 1}. ${s}`));
    if (tc.test_data?.length)
      lines.push(`Test data: ${tc.test_data.join("; ")}`);
    lines.push(`Expected: ${tc.expected_result}`);
    lines.push("");
  }
  lines.push("Return one Maestro YAML flow that runs all the above in sequence.");
  return lines.join("\n");
}

// ────────────────────────────────────────────────────────────────────────────
// XCUITest Swift
// ────────────────────────────────────────────────────────────────────────────

export function buildXCUITestSystemPrompt(conventions: RepoConventions): string {
  const bundleId = conventions.ios_bundle_id ?? "com.acme.app";
  const robotMode = conventions.use_robot_pattern;

  return `You are a senior iOS QA engineer producing XCUITest Swift code.

TARGET BUNDLE ID: ${bundleId}
DEPLOYMENT TARGET: iOS ${conventions.ios_deployment_target ?? "17.0"}+
PATTERN: ${robotMode ? "Robot / Screen Object pattern (one robot per screen)" : "Flat tests"}
SELECTOR STRATEGY: accessibility identifier (use \`app.buttons["login_button"]\` not label text)

REQUIREMENTS
1. Use XCUIApplication(bundleIdentifier: "${bundleId}") so this works in
   separate-repo setup (the app is installed on the simulator beforehand).
2. Include "import XCTest" at the top.
3. Class name: derived from the Jira ticket id (e.g. KAN_2_UITests).
4. Inherit from XCTestCase (or BaseUITest if Robot pattern is on — assume it
   exists in the same target).
5. setUp() should call continueAfterFailure = false and app.launch().
6. Each test method named test_<snake_case_of_test_scenario>().
7. Use XCUIElement.waitForExistence(timeout: 5) before assertions on elements
   that may not appear instantly.
8. Use XCTAssertTrue / XCTAssertEqual — never bare assertions.
9. Generate clean, idiomatic Swift 5.9+ — use trailing closures, guard let, etc.

OUTPUT
Return ONLY the raw Swift code — one .swift file content. No prose, no
markdown fences. The file must compile under Swift 5.9 with XCTest framework.`;
}

export function buildXCUITestUserPrompt(
  ticket: JiraTicket,
  testCases: TestCase[],
): string {
  return buildMaestroUserPrompt(ticket, testCases).replace(
    /Return one Maestro YAML.*/,
    "Return one XCUITest Swift file (XCTestCase subclass) implementing all the above test cases as separate test methods.",
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Espresso Kotlin
// ────────────────────────────────────────────────────────────────────────────

export function buildEspressoSystemPrompt(conventions: RepoConventions): string {
  const appId = conventions.android_application_id ?? "com.acme.app";
  const robotMode = conventions.use_robot_pattern;

  return `You are a senior Android QA engineer producing Espresso/Compose UI test Kotlin code.

TARGET APPLICATION ID: ${appId}
MIN SDK: ${conventions.android_min_sdk ?? 24}
PATTERN: ${robotMode ? "Robot pattern (one robot per screen)" : "Flat tests"}
SELECTOR STRATEGY: contentDescription / testTag (NOT visible text where avoidable)

REQUIREMENTS
1. Use AndroidX Test + Espresso (androidx.test.espresso.*).
2. For Compose UI, prefer ComposeTestRule + onNodeWithTag().
3. Use ActivityScenarioRule<MainActivity> as the entry point.
4. Class name derived from the Jira ticket id (e.g. KAN2InstrumentedTest).
5. @RunWith(AndroidJUnit4::class) on the class.
6. Each test method @Test fun test<CamelCaseScenario>().
7. Always end interactions with assertions — espresso has built-in waiting,
   but for Compose use waitUntil { ... } where needed.
8. Generate clean, idiomatic Kotlin 1.9+.

OUTPUT
Return ONLY the raw Kotlin code — one .kt file content. No prose, no
markdown fences. Must compile against AGP 8+.`;
}

export function buildEspressoUserPrompt(
  ticket: JiraTicket,
  testCases: TestCase[],
): string {
  return buildMaestroUserPrompt(ticket, testCases).replace(
    /Return one Maestro YAML.*/,
    "Return one Espresso Kotlin instrumented test file implementing all the above test cases as separate @Test methods.",
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Smart router — given conventions, decide which provider + prompts to use
// ────────────────────────────────────────────────────────────────────────────

export interface CodeGenSpec {
  systemPrompt: string;
  userPrompt: string;
  /** Suggested LLM provider for this format — caller can override. */
  recommendedProvider: "openai" | "gemini" | "anthropic";
  /** Filename for the resulting file. */
  filename: string;
  /** Where in the e2e repo to write it. */
  destinationPath: string;
  /** Whether the LLM should be asked for JSON output. Maestro YAML = no. */
  jsonMode: boolean;
}

export function buildCodeGenSpec(
  ticket: JiraTicket,
  testCases: TestCase[],
  conventions: RepoConventions,
): CodeGenSpec {
  const safeTicket = ticket.ticket_id.replace(/[^A-Za-z0-9-]/g, "_");

  switch (conventions.test_format) {
    case "maestro":
      return {
        systemPrompt: buildMaestroSystemPrompt(conventions),
        userPrompt: buildMaestroUserPrompt(ticket, testCases),
        recommendedProvider: "gemini",
        filename: `${safeTicket}.yaml`,
        destinationPath: `e2e/flows/${safeTicket}.yaml`,
        jsonMode: false,
      };
    case "xcuitest":
      return {
        systemPrompt: buildXCUITestSystemPrompt(conventions),
        userPrompt: buildXCUITestUserPrompt(ticket, testCases),
        recommendedProvider: "anthropic",
        filename: `${safeTicket}UITests.swift`,
        destinationPath: `UITests/${safeTicket}UITests.swift`,
        jsonMode: false,
      };
    case "espresso":
      return {
        systemPrompt: buildEspressoSystemPrompt(conventions),
        userPrompt: buildEspressoUserPrompt(ticket, testCases),
        recommendedProvider: "anthropic",
        filename: `${safeTicket}InstrumentedTest.kt`,
        destinationPath: `app/src/androidTest/java/com/jiraqa/${safeTicket}InstrumentedTest.kt`,
        jsonMode: false,
      };
  }
}
