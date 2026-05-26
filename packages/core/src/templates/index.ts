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
    `jobs:`,
    `  e2e:`,
    `    runs-on: macos-14`,
    `    steps:`,
    `      - name: Checkout e2e repo`,
    `        uses: actions/checkout@v4`,
    ``,
    `      - name: Checkout main app source`,
    `        uses: actions/checkout@v4`,
    `        with:`,
    `          repository: ${main.owner}/${main.repo}`,
    `          path: app-source`,
    `          token: \${{ secrets.GITHUB_TOKEN }}`,
    ``,
    `      - uses: ruby/setup-ruby@v1`,
    `        with:`,
    `          ruby-version: "3.2"`,
    `          bundler-cache: true`,
    ``,
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
    `      - name: Run e2e via Fastlane`,
    `        run: bundle exec fastlane ios e2e`,
    `        # SCHEME env var overrides the auto-guessed scheme name.`,
    `        # Uncomment + edit if the default doesn't match your Xcode scheme:`,
    `        # env:`,
    `        #   SCHEME: ${schemeHint(c)}`,
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
    `jobs:`,
    `  e2e:`,
    `    runs-on: ubuntu-latest`,
    `    steps:`,
    `      - uses: actions/checkout@v4`,
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
    `      - uses: ruby/setup-ruby@v1`,
    `        with: { ruby-version: "3.2", bundler-cache: true }`,
    ``,
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
    `        with:`,
    `          api-level: 34`,
    `          arch: x86_64`,
    `          script: bundle exec fastlane android e2e`,
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
