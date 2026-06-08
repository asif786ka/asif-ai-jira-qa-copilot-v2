/**
 * @module @jiraqa/core/templates
 *
 * Pure-function template generators. Each takes RepoConventions (and
 * sometimes JiraTicket info) and returns a `{ path, content }` object
 * describing one file to create in the e2e repo.
 *
 * The orchestration layer in /api/e2e/generate-pr collects these and
 * commits them to the new repo via the GitHub API.
 */

import type { RepoConventions } from "../types";

export interface GeneratedFile {
  path: string; // relative to repo root, e.g. "fastlane/Fastfile"
  content: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Fastlane Fastfile + Gemfile
// ────────────────────────────────────────────────────────────────────────────

export function generateFastfile(conventions: RepoConventions): GeneratedFile {
  const platform = conventions.platform;
  if (platform === "ios") return generateIosFastfile(conventions);
  if (platform === "android") return generateAndroidFastfile(conventions);
  return {
    path: "fastlane/Fastfile",
    content: "# Fastlane not used for web platform.\n",
  };
}

function generateIosFastfile(c: RepoConventions): GeneratedFile {
  const bundleId = c.ios_bundle_id ?? "com.acme.app";
  // Scheme name is a guess — user can edit if it doesn't match.
  // Heuristic: last segment of bundle id (e.g. "com.acme.MyApp" → "MyApp").
  const schemeGuess = bundleId.split(".").pop() ?? "App";
  const isMaestro = c.test_format === "maestro";

  // Layout assumed by this Fastfile:
  //   e2e-repo-root/
  //     fastlane/Fastfile              ← Fastfile cwd is e2e-repo-root/fastlane
  //     e2e/flows/                     ← Maestro flows
  //     app-source/                    ← main app checked out by CI (or local clone)
  //       <SchemeGuess>.xcodeproj      ← Xcode project lives here
  //
  // We resolve paths from __dir__ (this file's location) so the lane works
  // from CI (run by GitHub Actions) AND locally (run by a developer).
  const lines = [
    `default_platform(:ios)`,
    ``,
    `# NOTE: This Fastfile assumes the main app is checked out at`,
    `# ../app-source relative to this Fastfile. The CI workflow at`,
    `# .github/workflows/e2e-ios.yml clones it there automatically.`,
    `# Locally: clone the main app repo into ../app-source manually.`,
    ``,
    `platform :ios do`,
    `  desc "Build app for simulator and run ${isMaestro ? "Maestro flows" : "XCUITests"}"`,
    `  lane :e2e do`,
    `    repo_root = File.expand_path("..", __dir__)`,
    `    app_source = File.join(repo_root, "app-source")`,
    `    raise "Main app source not found at #{app_source}. CI checks it out automatically; for local runs, clone the main app repo into ../app-source." unless Dir.exist?(app_source)`,
    ``,
    `    # Discover scheme: prefer SCHEME env var, else default to "${schemeGuess}".`,
    `    scheme_name = ENV["SCHEME"] || "${schemeGuess}"`,
    ``,
    `    Dir.chdir(app_source) do`,
    `      build_app(`,
    `        scheme: scheme_name,`,
    `        configuration: "Debug",`,
    `        destination: "generic/platform=iOS Simulator",`,
    `        skip_archive: true,`,
    `        skip_codesigning: true,`,
    `        derived_data_path: "build"`,
    `      )`,
    `      sh("xcrun simctl install booted build/Build/Products/Debug-iphonesimulator/#{scheme_name}.app")`,
    `    end`,
    ``,
    isMaestro
      ? `    sh("maestro test #{File.join(repo_root, "e2e", "flows")}")`
      : `    sh("xcodebuild test-without-building -xctestrun #{File.join(repo_root, "Tests.xctestrun")}")`,
    `  end`,
    `end`,
    ``,
  ];

  return { path: "fastlane/Fastfile", content: lines.join("\n") };
}

function generateAndroidFastfile(c: RepoConventions): GeneratedFile {
  const isMaestro = c.test_format === "maestro";

  const lines = [
    `default_platform(:android)`,
    ``,
    `# This Fastfile assumes the main app is checked out at ../app-source`,
    `# relative to this Fastfile. CI clones it there automatically.`,
    ``,
    `platform :android do`,
    `  desc "Build APK and run ${isMaestro ? "Maestro flows" : "Espresso tests"}"`,
    `  lane :e2e do`,
    `    repo_root = File.expand_path("..", __dir__)`,
    `    app_source = File.join(repo_root, "app-source")`,
    `    raise "Main app source not found at #{app_source}. CI checks it out automatically; for local runs, clone the main app repo into ../app-source." unless Dir.exist?(app_source)`,
    ``,
    `    Dir.chdir(app_source) do`,
    `      gradle(task: "assembleDebug")`,
    isMaestro
      ? `      sh("adb install -r app/build/outputs/apk/debug/app-debug.apk")`
      : `      gradle(task: "connectedDebugAndroidTest")`,
    `    end`,
    ``,
    isMaestro
      ? `    sh("maestro test #{File.join(repo_root, "e2e", "flows")}")`
      : `    # Espresso runs inside the Android instrumentation context — no Maestro step needed.`,
    `  end`,
    `end`,
    ``,
  ];

  return { path: "fastlane/Fastfile", content: lines.join("\n") };
}

export function generateGemfile(): GeneratedFile {
  return {
    path: "Gemfile",
    content: [
      `source "https://rubygems.org"`,
      ``,
      `gem "fastlane"`,
      ``,
    ].join("\n"),
  };
}

export function generateAppfile(c: RepoConventions): GeneratedFile {
  if (c.platform === "ios") {
    return {
      path: "fastlane/Appfile",
      content: [
        `app_identifier("${c.ios_bundle_id ?? "com.acme.app"}")`,
        `# apple_id("you@example.com")    # uncomment + fill once configured`,
        `# team_id("ABC123DEF4")          # only needed for device testing`,
        ``,
      ].join("\n"),
    };
  }
  if (c.platform === "android") {
    return {
      path: "fastlane/Appfile",
      content: [
        `package_name("${c.android_application_id ?? "com.acme.app"}")`,
        ``,
      ].join("\n"),
    };
  }
  return { path: "fastlane/Appfile", content: "" };
}

// ────────────────────────────────────────────────────────────────────────────
// GitHub Actions workflows
// ────────────────────────────────────────────────────────────────────────────

export function generateGithubActionsWorkflow(
  conventions: RepoConventions,
  mainRepo: { owner: string; repo: string },
): GeneratedFile {
  if (conventions.platform === "ios") {
    return iosGithubActions(conventions, mainRepo);
  }
  if (conventions.platform === "android") {
    return androidGithubActions(conventions, mainRepo);
  }
  return {
    path: ".github/workflows/e2e.yml",
    content: "# Web e2e workflow not yet templated.\n",
  };
}

function iosGithubActions(
  c: RepoConventions,
  main: { owner: string; repo: string },
): GeneratedFile {
  const isMaestro = c.test_format === "maestro";
  const lines = [
    `name: iOS E2E`,
    ``,
    `on:`,
    `  pull_request:`,
    `  push:`,
    `    branches: [main]`,
    `  workflow_dispatch:`,
    ``,
    // ── Permissions required by the PR-comment step (actions/github-script).
    // Default GITHUB_TOKEN has only `contents: read`; posting a PR comment
    // needs `issues: write` (PR comments live under the Issues API) and
    // `pull-requests: write`. Declared at the workflow level — least
    // surprise, applies to every step.
    `permissions:`,
    `  contents: read`,
    `  issues: write`,
    `  pull-requests: write`,
    ``,
    `jobs:`,
    `  e2e:`,
    `    runs-on: macos-14`,
    `    steps:`,
    `      - name: Checkout e2e repo`,
    `        uses: actions/checkout@v4`,
    `        with:`,
    `          # Full history so the Maestro step can git-diff against the`,
    `          # PR base and run ONLY the flows this PR added/modified.`,
    `          # Without this we'd re-run every historical flow on every PR`,
    `          # — one broken legacy file would fail the whole batch.`,
    `          fetch-depth: 0`,
    ``,
    `      - name: Checkout main app source`,
    `        uses: actions/checkout@v4`,
    `        with:`,
    `          repository: ${main.owner}/${main.repo}`,
    `          path: app-source`,
    `          token: \${{ secrets.GITHUB_TOKEN }}`,
    ``,
    // ── Ruby + Fastlane only when we actually need them (XCUITest).
    // Maestro is a single shell command; loading Fastlane just to wrap
    // `maestro test` triggers Ruby gem-load issues (Fastlane 2.235 eagerly
    // requires google-apis-playcustomapp → multi_json) that have nothing
    // to do with the user's tests. Skip the whole Ruby chain for Maestro.
    ...(isMaestro
      ? []
      : [
          `      - uses: ruby/setup-ruby@v1`,
          `        with:`,
          `          ruby-version: "3.2"`,
          `          bundler-cache: true`,
          ``,
        ]),
    ...(isMaestro
      ? [
          `      - name: Install Maestro`,
          `        run: |`,
          `          curl -Ls "https://get.maestro.mobile.dev" | bash`,
          `          echo "$HOME/.maestro/bin" >> $GITHUB_PATH`,
        ]
      : []),
    ``,
    `      - name: Boot simulator`,
    `        run: |`,
    `          xcrun simctl boot "iPhone 15" || true`,
    `          xcrun simctl bootstatus "iPhone 15" -b`,
    ``,
    ...(isMaestro
      ? [
          `      - name: Run Maestro flows`,
          `        id: e2e`,
          `        env:`,
          `          # The PR's actual base/head SHAs are more reliable than github.base_ref`,
          `          # — they're stable even when the PR's base branch has moved forward.`,
          `          PR_BASE_SHA: \${{ github.event.pull_request.base.sha }}`,
          `          PR_HEAD_SHA: \${{ github.event.pull_request.head.sha }}`,
          `        run: |`,
          `          set -e`,
          `          # PR-scoped flow discovery — run only the YAMLs THIS pull request`,
          `          # added or modified, identified via 'appId:' content. Avoids`,
          `          # re-running every historical flow (one legacy parse error would`,
          `          # otherwise fail the whole batch).`,
          `          EVENT="\${{ github.event_name }}"`,
          `          echo "::group::Diff context"`,
          `          echo "  event:    $EVENT"`,
          `          echo "  base SHA: $PR_BASE_SHA"`,
          `          echo "  head SHA: $PR_HEAD_SHA"`,
          `          echo "  HEAD:     $(git rev-parse HEAD)"`,
          `          echo "::endgroup::"`,
          ``,
          `          if [ "$EVENT" = "pull_request" ] && [ -n "$PR_BASE_SHA" ]; then`,
          `            git fetch --no-tags --depth=50 origin "$PR_BASE_SHA" 2>/dev/null || true`,
          `            RANGE="$PR_BASE_SHA...HEAD"`,
          `          elif [ "$EVENT" = "push" ]; then`,
          `            RANGE="HEAD~1...HEAD"`,
          `          else`,
          `            RANGE=""`,
          `          fi`,
          ``,
          `          if [ -n "$RANGE" ]; then`,
          `            echo "::group::Files changed in $RANGE"`,
          `            git diff --name-only "$RANGE" 2>&1 | head -50 || true`,
          `            echo "::endgroup::"`,
          `            CANDIDATES=$(git diff --name-only --diff-filter=AM "$RANGE" -- \\`,
          `                          '*.yaml' '*.yml' 2>/dev/null \\`,
          `                          | grep -v '^.github/' || true)`,
          `          else`,
          `            # Manual workflow_dispatch — fall back to all Maestro YAMLs in the repo.`,
          `            CANDIDATES=$(grep -lE '^appId:' -r --include='*.yaml' --include='*.yml' . \\`,
          `                          2>/dev/null | grep -v '^./.github/' || true)`,
          `          fi`,
          ``,
          `          echo "Candidates after diff filter:"`,
          `          echo "$CANDIDATES" | sed 's/^/  /' || echo "  (none)"`,
          ``,
          `          FLOWS=()`,
          `          for f in $CANDIDATES; do`,
          `            [ -f "$f" ] || { echo "  skip (missing): $f"; continue; }`,
          `            # JiraQA prepends a marker comment ('# jiraqa: generated ...') so`,
          `            # the appId: declaration is usually on line 2 or 3, not line 1.`,
          `            # Scan the first 10 lines instead of just the head.`,
          `            head -n 10 "$f" | grep -q '^appId:' || { echo "  skip (no appId in first 10 lines): $f"; continue; }`,
          `            FLOWS+=("$f")`,
          `          done`,
          ``,
          `          if [ \${#FLOWS[@]} -eq 0 ]; then`,
          `            echo "::warning::No Maestro flow files (.yaml/.yml starting with 'appId:') were added or modified in this PR."`,
          `            echo "::warning::If the codegen produced files under a different extension, check the agentic-e2e-codegen response for the actual paths."`,
          `            # Exit 0 so the workflow is reported as a pass when there's`,
          `            # nothing to test — distinct from a failed Maestro run.`,
          `            exit 0`,
          `          fi`,
          `          echo "Found \${#FLOWS[@]} flow(s) to run:"`,
          `          printf '  %s\\n' "\${FLOWS[@]}"`,
          ``,
          `          # Dump file contents up-front so the failure log always shows what`,
          `          # was being tested — saves a second round-trip when the LLM produced`,
          `          # malformed YAML.`,
          `          for f in "\${FLOWS[@]}"; do`,
          `            echo "::group::$f"`,
          `            cat -n "$f"`,
          `            echo "::endgroup::"`,
          `          done`,
          ``,
          `          # Preflight — 'maestro check' parses each flow against the Maestro`,
          `          # spec without running it on the device. Catches malformed YAML in`,
          `          # under a second; surfaces the exact line:col in CI logs.`,
          `          echo "::group::Preflight (maestro check)"`,
          `          for f in "\${FLOWS[@]}"; do`,
          `            if ! maestro check-syntax "$f"; then`,
          `              echo "::error file=$f::Maestro 'check' rejected this flow — fix the YAML and regenerate the PR"`,
          `              exit 1`,
          `            fi`,
          `          done`,
          `          echo "::endgroup::"`,
          ``,
          `          maestro test "\${FLOWS[@]}"`,
          ``,
        ]
      : [
          `      - name: Run e2e via Fastlane`,
          `        id: e2e`,
          `        run: bundle exec fastlane ios e2e`,
          `        # SCHEME env var overrides the auto-guessed scheme name.`,
          `        # Uncomment + edit if the default doesn't match your Xcode scheme:`,
          `        # env:`,
          `        #   SCHEME: ${schemeHint(c)}`,
          ``,
        ]),
    // ── Proof artifacts — visible on the PR's "Checks" tab. Demoable in
    // an interview without needing to re-run the pipeline live.
    `      - name: Collect Maestro artifacts`,
    `        if: always()`,
    `        run: |`,
    `          mkdir -p artifacts`,
    `          # Maestro writes runs to ~/.maestro/tests/<timestamp>/`,
    `          cp -R ~/.maestro/tests artifacts/maestro-runs 2>/dev/null || true`,
    `          # Pick up xcresult bundles if Fastlane produced any`,
    `          find . -name "*.xcresult" -maxdepth 4 -exec cp -R {} artifacts/ \\; 2>/dev/null || true`,
    `          ls -lah artifacts || true`,
    ``,
    `      - name: Upload Maestro screenshots + video`,
    `        if: always()`,
    `        uses: actions/upload-artifact@v4`,
    `        with:`,
    `          name: maestro-ios-\${{ github.run_number }}`,
    `          path: artifacts`,
    `          if-no-files-found: warn`,
    `          retention-days: 30`,
    ``,
    `      - name: Comment PR with test outcome`,
    `        if: always() && github.event_name == 'pull_request'`,
    `        uses: actions/github-script@v7`,
    `        with:`,
    `          script: |`,
    `            const status = '\${{ steps.e2e.outcome }}' === 'success' ? '✅ PASSED' : '❌ FAILED';`,
    `            const url = \`\${process.env.GITHUB_SERVER_URL}/\${process.env.GITHUB_REPOSITORY}/actions/runs/\${process.env.GITHUB_RUN_ID}\`;`,
    `            const body = [`,
    `              \`### Maestro iOS E2E: \${status}\`,`,
    `              '',`,
    `              \`- Runner: macos-14 · iPhone 15 simulator\`,`,
    `              \`- Run: \${url}\`,`,
    `              \`- Artifacts: screenshots + recording attached to this run (retention 30d)\`,`,
    `            ].join('\\n');`,
    `            github.rest.issues.createComment({`,
    `              owner: context.repo.owner,`,
    `              repo: context.repo.repo,`,
    `              issue_number: context.issue.number,`,
    `              body`,
    `            });`,
    ``,
  ];
  return { path: ".github/workflows/e2e-ios.yml", content: lines.join("\n") };
}

function schemeHint(c: RepoConventions): string {
  return c.ios_bundle_id?.split(".").pop() ?? "YourApp";
}

function androidGithubActions(
  c: RepoConventions,
  main: { owner: string; repo: string },
): GeneratedFile {
  const isMaestro = c.test_format === "maestro";
  const lines = [
    `name: Android E2E`,
    ``,
    `on:`,
    `  pull_request:`,
    `  push:`,
    `    branches: [main]`,
    `  workflow_dispatch:`,
    ``,
    // ── Same rationale as the iOS workflow — github-script needs these.
    `permissions:`,
    `  contents: read`,
    `  issues: write`,
    `  pull-requests: write`,
    ``,
    `jobs:`,
    `  e2e:`,
    `    runs-on: ubuntu-latest`,
    `    steps:`,
    `      - uses: actions/checkout@v4`,
    `        with:`,
    `          # Full history so the Maestro step can diff this PR vs base.`,
    `          fetch-depth: 0`,
    ``,
    `      - name: Checkout main app source`,
    `        uses: actions/checkout@v4`,
    `        with:`,
    `          repository: ${main.owner}/${main.repo}`,
    `          path: app-source`,
    `          token: \${{ secrets.GITHUB_TOKEN }}`,
    ``,
    `      - uses: actions/setup-java@v4`,
    `        with: { distribution: temurin, java-version: "17" }`,
    ``,
    // ── Ruby + Fastlane only when we actually need them. See iOS comment
    // above — Maestro is a single shell command; loading Fastlane just to
    // wrap it triggers Ruby gem-load issues (multi_json) for no upside.
    ...(isMaestro
      ? []
      : [
          `      - uses: ruby/setup-ruby@v1`,
          `        with: { ruby-version: "3.2", bundler-cache: true }`,
          ``,
        ]),
    ...(isMaestro
      ? [
          `      - name: Install Maestro`,
          `        run: |`,
          `          curl -Ls "https://get.maestro.mobile.dev" | bash`,
          `          echo "$HOME/.maestro/bin" >> $GITHUB_PATH`,
        ]
      : []),
    ``,
    `      - name: Enable KVM`,
    `        run: |`,
    `          echo 'KERNEL=="kvm", GROUP="kvm", MODE="0666"' | sudo tee /etc/udev/rules.d/99-kvm4all.rules`,
    `          sudo udevadm control --reload-rules && sudo udevadm trigger --name-match=kvm`,
    ``,
    `      - uses: reactivecircus/android-emulator-runner@v2`,
    `        id: e2e`,
    `        with:`,
    `          api-level: 34`,
    `          arch: x86_64`,
    ...(isMaestro
      ? [
          `          script: |`,
          `            set -e`,
          `            EVENT="\${{ github.event_name }}"`,
          `            if [ "$EVENT" = "pull_request" ]; then`,
          `              BASE="\${{ github.base_ref }}"`,
          `              git fetch --no-tags --depth=50 origin "$BASE" 2>/dev/null || true`,
          `              RANGE="origin/$BASE...HEAD"`,
          `            elif [ "$EVENT" = "push" ]; then`,
          `              RANGE="HEAD~1...HEAD"`,
          `            else`,
          `              RANGE=""`,
          `            fi`,
          `            if [ -n "$RANGE" ]; then`,
          `              CANDIDATES=$(git diff --name-only --diff-filter=AM "$RANGE" -- '*.yaml' '*.yml' 2>/dev/null | grep -v '^.github/' || true)`,
          `            else`,
          `              CANDIDATES=$(grep -lE '^appId:' -r --include='*.yaml' --include='*.yml' . 2>/dev/null | grep -v '^./.github/' || true)`,
          `            fi`,
          `            FLOWS=()`,
          `            for f in $CANDIDATES; do`,
          `              [ -f "$f" ] || continue`,
          `              # appId may be past the JiraQA marker comment line, so scan first 10.`,
          `              head -n 10 "$f" | grep -q '^appId:' || continue`,
          `              FLOWS+=("$f")`,
          `            done`,
          `            if [ \${#FLOWS[@]} -eq 0 ]; then echo "::notice::No new flows — skipping."; exit 0; fi`,
          `            echo "Found \${#FLOWS[@]} flow(s):"; printf '  %s\\n' "\${FLOWS[@]}"`,
          `            maestro test "\${FLOWS[@]}"`,
        ]
      : [
          `          script: bundle exec fastlane android e2e`,
        ]),
    ``,
    // ── Proof artifacts — visible on the PR's Checks tab.
    `      - name: Collect Maestro artifacts`,
    `        if: always()`,
    `        run: |`,
    `          mkdir -p artifacts`,
    `          cp -R ~/.maestro/tests artifacts/maestro-runs 2>/dev/null || true`,
    `          ls -lah artifacts || true`,
    ``,
    `      - name: Upload Maestro screenshots + video`,
    `        if: always()`,
    `        uses: actions/upload-artifact@v4`,
    `        with:`,
    `          name: maestro-android-\${{ github.run_number }}`,
    `          path: artifacts`,
    `          if-no-files-found: warn`,
    `          retention-days: 30`,
    ``,
    `      - name: Comment PR with test outcome`,
    `        if: always() && github.event_name == 'pull_request'`,
    `        uses: actions/github-script@v7`,
    `        with:`,
    `          script: |`,
    `            const status = '\${{ steps.e2e.outcome }}' === 'success' ? '✅ PASSED' : '❌ FAILED';`,
    `            const url = \`\${process.env.GITHUB_SERVER_URL}/\${process.env.GITHUB_REPOSITORY}/actions/runs/\${process.env.GITHUB_RUN_ID}\`;`,
    `            const body = [`,
    `              \`### Maestro Android E2E: \${status}\`,`,
    `              '',`,
    `              \`- Runner: ubuntu-latest · Android API 34 emulator\`,`,
    `              \`- Run: \${url}\`,`,
    `              \`- Artifacts: screenshots + recording attached to this run (retention 30d)\`,`,
    `            ].join('\\n');`,
    `            github.rest.issues.createComment({`,
    `              owner: context.repo.owner,`,
    `              repo: context.repo.repo,`,
    `              issue_number: context.issue.number,`,
    `              body`,
    `            });`,
    ``,
  ];
  return {
    path: ".github/workflows/e2e-android.yml",
    content: lines.join("\n"),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// CircleCI
// ────────────────────────────────────────────────────────────────────────────

export function generateCircleciConfig(
  conventions: RepoConventions,
): GeneratedFile {
  const isIos = conventions.platform === "ios";
  const lines = [
    `version: 2.1`,
    ``,
    `orbs:`,
    `  macos: circleci/macos@2`,
    ``,
    `jobs:`,
    `  ${isIos ? "ios-e2e" : "android-e2e"}:`,
    isIos
      ? `    macos:\n      xcode: 15.4.0\n    resource_class: macos.m1.medium.gen1`
      : `    machine:\n      image: android:2024.04.1\n    resource_class: large`,
    `    steps:`,
    `      - checkout`,
    `      - run: bundle install`,
    conventions.test_format === "maestro"
      ? `      - run: curl -Ls "https://get.maestro.mobile.dev" | bash`
      : "",
    isIos
      ? `      - macos/preboot-simulator:\n          device: iPhone 15`
      : "",
    `      - run: bundle exec fastlane ${isIos ? "ios" : "android"} e2e`,
    ``,
    `workflows:`,
    `  test:`,
    `    jobs:`,
    `      - ${isIos ? "ios-e2e" : "android-e2e"}`,
    ``,
  ];
  return { path: ".circleci/config.yml", content: lines.filter(Boolean).join("\n") };
}

// ────────────────────────────────────────────────────────────────────────────
// README for the new e2e repo
// ────────────────────────────────────────────────────────────────────────────

export function generateReadme(
  conventions: RepoConventions,
  mainRepo: { owner: string; repo: string },
): GeneratedFile {
  const format = conventions.test_format;
  const platform = conventions.platform;
  return {
    path: "README.md",
    content: [
      `# ${mainRepo.repo} — ${platform.toUpperCase()} E2E tests`,
      ``,
      `Generated by [jiraqa.com](https://jiraqa.com). Tests live in this repo, separately from the main app at \`${mainRepo.owner}/${mainRepo.repo}\`.`,
      ``,
      `## Test format`,
      `**${format}** — ${describeFormat(format)}`,
      ``,
      `## Running locally`,
      ``,
      `\`\`\`bash`,
      `bundle install                                # installs fastlane`,
      ...(format === "maestro"
        ? [`curl -Ls "https://get.maestro.mobile.dev" | bash    # install maestro once`]
        : []),
      `bundle exec fastlane ${platform === "ios" ? "ios" : "android"} e2e`,
      `\`\`\``,
      ``,
      `## CI`,
      `GitHub Actions workflow at \`.github/workflows/e2e-${platform}.yml\` runs on every PR and on pushes to \`main\`.`,
      ``,
      `## Adding new tests`,
      `Generate them in [jiraqa.com](https://jiraqa.com) by picking another Jira ticket — they'll land here as a new PR.`,
      ``,
      `## License`,
      `Inherits from \`${mainRepo.owner}/${mainRepo.repo}\`.`,
      ``,
    ].join("\n"),
  };
}

function describeFormat(f: RepoConventions["test_format"]): string {
  switch (f) {
    case "maestro":
      return "YAML-based mobile UI tests via [Maestro](https://maestro.mobile.dev).";
    case "xcuitest":
      return "Swift tests via Apple's XCUITest framework.";
    case "espresso":
      return "Kotlin instrumented tests via AndroidX Espresso / Compose UI Test.";
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Aggregate generator — returns every scaffolding file for the conventions
// ────────────────────────────────────────────────────────────────────────────

export function generateAllScaffolding(
  conventions: RepoConventions,
  mainRepo: { owner: string; repo: string },
): GeneratedFile[] {
  const files: GeneratedFile[] = [];

  if (conventions.use_fastlane) {
    files.push(generateFastfile(conventions));
    files.push(generateGemfile());
    files.push(generateAppfile(conventions));
  }

  if (
    conventions.ci_platform === "github_actions" ||
    conventions.ci_platform === "both"
  ) {
    files.push(generateGithubActionsWorkflow(conventions, mainRepo));
  }
  if (
    conventions.ci_platform === "circleci" ||
    conventions.ci_platform === "both"
  ) {
    files.push(generateCircleciConfig(conventions));
  }

  files.push(generateReadme(conventions, mainRepo));

  // .gitignore is universal scaffolding regardless of conventions.
  files.push({
    path: ".gitignore",
    content: [
      `# OS`,
      `.DS_Store`,
      ``,
      `# Build`,
      `build/`,
      `DerivedData/`,
      `*.xcuserstate`,
      ``,
      `# Ruby`,
      `.bundle/`,
      `vendor/`,
      ``,
      `# Local`,
      `.env.local`,
      `*.log`,
      ``,
    ].join("\n"),
  });

  return files;
}
