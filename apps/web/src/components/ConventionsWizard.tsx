"use client";

/**
 * Phase 11.3 — Conventions wizard modal.
 *
 * Opens when the user has picked a Jira ticket + GitHub repo + platform
 * but hasn't yet saved E2E conventions for that repo+platform combo.
 *
 * Five questions, smart defaults pre-selected. Auto-detected values
 * (bundle ID, deployment target, dependency manager) are shown read-only
 * as small badges so the user knows we figured them out.
 */

import { useEffect, useMemo, useState } from "react";
import type { Platform, RepoConventions } from "@jiraqa/core";
import {
  Apple,
  Smartphone,
  Sparkles,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  X,
} from "lucide-react";

type Props = {
  owner: string;
  repo: string;
  platform: Platform;
  onSaved: (c: RepoConventions) => void;
  onClose: () => void;
};

type Detected = {
  ios_bundle_id?: string;
  ios_deployment_target?: string;
  ios_dependency_manager?:
    | "spm"
    | "cocoapods"
    | "carthage"
    | "tuist"
    | "xcodegen";
  android_application_id?: string;
  android_min_sdk?: number;
};

export function ConventionsWizard({
  owner,
  repo,
  platform,
  onSaved,
  onClose,
}: Props) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [detectError, setDetectError] = useState<string | null>(null);
  const [detected, setDetected] = useState<Detected>({});

  // The five wizard answers.
  const [testFormat, setTestFormat] = useState<
    "maestro" | "xcuitest" | "espresso"
  >(platform === "android" ? "maestro" : "maestro");
  const [ciPlatform, setCiPlatform] = useState<
    "github_actions" | "circleci" | "both" | "none"
  >("github_actions");
  const [executionBackend, setExecutionBackend] = useState<
    | "local"
    | "github_actions"
    | "maestro_cloud"
    | "firebase_test_lab"
    | "browserstack"
    | "saucelabs"
    | "lambdatest"
  >("local");
  const [iosSigningMode, setIosSigningMode] = useState<
    "simulator_only" | "device"
  >("simulator_only");
  const [useRobotPattern, setUseRobotPattern] = useState(true);

  // Manual overrides for auto-detected values. Pre-filled when detection
  // succeeds, but always editable so users can fix wrong detections or
  // fill in when detection fails.
  const [bundleIdOverride, setBundleIdOverride] = useState<string>("");
  const [androidAppIdOverride, setAndroidAppIdOverride] = useState<string>("");

  // Auto-detect on open
  useEffect(() => {
    setLoading(true);
    setDetectError(null);
    fetch(
      `/api/github/detect-conventions?owner=${encodeURIComponent(
        owner,
      )}&repo=${encodeURIComponent(repo)}&platform=${platform}`,
    )
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) {
          setDetectError(d.error ?? `HTTP ${r.status}`);
        } else {
          const det: Detected = d.detected ?? {};
          setDetected(det);
          // Pre-fill manual fields with detected values so the user can edit them
          if (det.ios_bundle_id) setBundleIdOverride(det.ios_bundle_id);
          if (det.android_application_id)
            setAndroidAppIdOverride(det.android_application_id);
        }
      })
      .catch((e) => setDetectError((e as Error).message))
      .finally(() => setLoading(false));
  }, [owner, repo, platform]);

  // Compute available test formats based on platform
  const availableFormats = useMemo<
    Array<{ id: "maestro" | "xcuitest" | "espresso"; label: string; sub: string }>
  >(() => {
    if (platform === "ios") {
      return [
        {
          id: "maestro",
          label: "Maestro",
          sub: "YAML · separate repo · 5-min setup",
        },
        {
          id: "xcuitest",
          label: "XCUITest",
          sub: "Swift · separate repo · ~10-min setup",
        },
      ];
    }
    if (platform === "android") {
      return [
        {
          id: "maestro",
          label: "Maestro",
          sub: "YAML · separate repo · 5-min setup",
        },
        {
          id: "espresso",
          label: "Espresso",
          sub: "Kotlin · separate repo · ~10-min setup",
        },
      ];
    }
    return [{ id: "maestro", label: "Maestro", sub: "YAML" }];
  }, [platform]);

  async function save() {
    setSaving(true);
    const conventions: RepoConventions = {
      platform,
      test_format: testFormat,
      repo_strategy: "separate", // locked per user's earlier decision
      e2e_repo_name: `${repo}-${platform}-e2e`,
      ci_platform: ciPlatform,
      use_fastlane: true,
      execution_backend: executionBackend,
      ios_bundle_id: bundleIdOverride.trim() || detected.ios_bundle_id,
      ios_deployment_target: detected.ios_deployment_target,
      ios_dependency_manager: detected.ios_dependency_manager,
      ios_signing_mode: iosSigningMode,
      android_application_id:
        androidAppIdOverride.trim() || detected.android_application_id,
      android_min_sdk: detected.android_min_sdk,
      use_robot_pattern: useRobotPattern,
      selector_strategy: "accessibility_id",
      detected_at: new Date().toISOString(),
    };
    const res = await fetch("/api/conventions", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ owner, repo, conventions }),
    });
    setSaving(false);
    if (res.ok) {
      const d = await res.json();
      onSaved(d.conventions);
    }
  }

  const platformIcon =
    platform === "ios" ? (
      <Apple className="w-4 h-4" />
    ) : platform === "android" ? (
      <Smartphone className="w-4 h-4" />
    ) : (
      <Sparkles className="w-4 h-4" />
    );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm animate-fade-in">
      <div className="card max-w-2xl w-[92%] max-h-[90vh] overflow-y-auto relative">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-gray-400 hover:text-white"
          aria-label="Close"
        >
          <X className="w-4 h-4" />
        </button>

        <header className="mb-5">
          <div className="flex items-center gap-2 mb-1">
            <span className="pill">{platformIcon} {platform}</span>
            <span className="pill text-gray-400">{owner}/{repo}</span>
          </div>
          <h2 className="text-lg font-semibold">E2E test conventions</h2>
          <p className="text-xs text-gray-400 mt-1">
            We'll save these per-repo. Smart defaults are pre-selected — usually
            you can just click Save.
          </p>
        </header>

        {loading ? (
          <div className="text-xs text-gray-400 flex items-center gap-2">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            Detecting project structure...
          </div>
        ) : (
          <>
            {detectError && (
              <div className="text-xs text-yellow-300 bg-yellow-500/10 border border-yellow-500/30 rounded p-2 mb-4 flex items-start gap-2">
                <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <span>
                  Could not auto-detect everything. You can still continue — we'll
                  use defaults. ({detectError})
                </span>
              </div>
            )}

            {/* Auto-detected facts shown read-only */}
            {hasAnyDetected(detected, platform) && (
              <div className="mb-4">
                <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">
                  Auto-detected
                </div>
                <div className="flex flex-wrap gap-1.5 text-[11px]">
                  {detected.ios_deployment_target && (
                    <DetectedPill
                      label="iOS target"
                      value={detected.ios_deployment_target}
                    />
                  )}
                  {detected.ios_dependency_manager && (
                    <DetectedPill
                      label="deps"
                      value={detected.ios_dependency_manager}
                    />
                  )}
                  {detected.android_min_sdk && (
                    <DetectedPill
                      label="min SDK"
                      value={String(detected.android_min_sdk)}
                    />
                  )}
                </div>
              </div>
            )}

            {/* Always-editable identifier — pre-filled from auto-detect when found */}
            {platform === "ios" && (
              <div className="mb-4">
                <label className="text-xs text-gray-400 block mb-1">
                  iOS bundle identifier{" "}
                  <span className="text-gray-500">
                    (the appId Maestro launches, e.g. com.acme.app)
                  </span>
                </label>
                <input
                  className="input"
                  value={bundleIdOverride}
                  onChange={(e) => setBundleIdOverride(e.target.value)}
                  placeholder="com.acme.app"
                />
                {!bundleIdOverride && (
                  <p className="text-[11px] text-yellow-300 mt-1">
                    Couldn't auto-detect — add yours manually. Find it in
                    Xcode → your target → General → Bundle Identifier.
                  </p>
                )}
              </div>
            )}
            {platform === "android" && (
              <div className="mb-4">
                <label className="text-xs text-gray-400 block mb-1">
                  Android application ID{" "}
                  <span className="text-gray-500">
                    (e.g. com.acme.app)
                  </span>
                </label>
                <input
                  className="input"
                  value={androidAppIdOverride}
                  onChange={(e) => setAndroidAppIdOverride(e.target.value)}
                  placeholder="com.acme.app"
                />
                {!androidAppIdOverride && (
                  <p className="text-[11px] text-yellow-300 mt-1">
                    Couldn't auto-detect — check the applicationId in your
                    app's build.gradle.
                  </p>
                )}
              </div>
            )}

            {/* Q1: test format */}
            <Question title="1. Test format">
              <div className="grid grid-cols-2 gap-2">
                {availableFormats.map((opt) => (
                  <OptionCard
                    key={opt.id}
                    active={testFormat === opt.id}
                    onClick={() => setTestFormat(opt.id)}
                    label={opt.label}
                    sub={opt.sub}
                    recommended={opt.id === "maestro"}
                  />
                ))}
              </div>
            </Question>

            {/* Q2: CI platform */}
            <Question title="2. CI platform">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                <OptionCard
                  active={ciPlatform === "github_actions"}
                  onClick={() => setCiPlatform("github_actions")}
                  label="GitHub Actions"
                  sub="free for public repos"
                  recommended
                />
                <OptionCard
                  active={ciPlatform === "circleci"}
                  onClick={() => setCiPlatform("circleci")}
                  label="CircleCI"
                  sub="bring your orb"
                />
                <OptionCard
                  active={ciPlatform === "both"}
                  onClick={() => setCiPlatform("both")}
                  label="Both"
                  sub="generate both"
                />
                <OptionCard
                  active={ciPlatform === "none"}
                  onClick={() => setCiPlatform("none")}
                  label="None"
                  sub="add later"
                />
              </div>
            </Question>

            {/* Q3: execution backend */}
            <Question title="3. Where do tests run">
              <select
                className="input"
                value={executionBackend}
                onChange={(e) =>
                  setExecutionBackend(e.target.value as typeof executionBackend)
                }
              >
                <option value="local">Local simulator/emulator (free)</option>
                <option value="github_actions">GitHub Actions runners</option>
                <option value="maestro_cloud">Maestro Cloud (mobile.dev)</option>
                <option value="firebase_test_lab">Firebase Test Lab (Google)</option>
                <option value="browserstack">BrowserStack App Automate</option>
                <option value="saucelabs">Sauce Labs</option>
                <option value="lambdatest">LambdaTest</option>
              </select>
              <p className="text-[11px] text-gray-500 mt-1">
                We'll generate the right CI config for your choice. You can change
                this later in Edit Conventions.
              </p>
            </Question>

            {/* Q4: iOS-only — signing mode */}
            {platform === "ios" && (
              <Question title="4. iOS signing">
                <div className="grid grid-cols-2 gap-2">
                  <OptionCard
                    active={iosSigningMode === "simulator_only"}
                    onClick={() => setIosSigningMode("simulator_only")}
                    label="Simulator only"
                    sub="free Apple ID works"
                    recommended
                  />
                  <OptionCard
                    active={iosSigningMode === "device"}
                    onClick={() => setIosSigningMode("device")}
                    label="Also real devices"
                    sub="paid Apple Dev needed"
                  />
                </div>
              </Question>
            )}

            {/* Q5: pattern */}
            <Question title={platform === "ios" ? "5. Code organization" : "4. Code organization"}>
              <div className="grid grid-cols-2 gap-2">
                <OptionCard
                  active={useRobotPattern}
                  onClick={() => setUseRobotPattern(true)}
                  label="Robot / Page Object"
                  sub="scales better"
                  recommended
                />
                <OptionCard
                  active={!useRobotPattern}
                  onClick={() => setUseRobotPattern(false)}
                  label="Flat tests"
                  sub="simpler for small suites"
                />
              </div>
            </Question>

            <div className="flex gap-2 mt-6">
              <button onClick={onClose} className="btn-ghost flex-1">
                Cancel
              </button>
              <button
                onClick={save}
                disabled={saving}
                className="btn-primary flex-1"
              >
                {saving ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" /> Saving...
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="w-3.5 h-3.5" /> Save conventions
                  </>
                )}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Sub-components (kept in the same file for one-page reviewability)
// ────────────────────────────────────────────────────────────────────────────

function Question({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-4">
      <h3 className="text-xs font-semibold text-gray-300 mb-2">{title}</h3>
      {children}
    </section>
  );
}

function OptionCard({
  active,
  onClick,
  label,
  sub,
  recommended,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  sub: string;
  recommended?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`text-left rounded-lg border p-2.5 transition ${
        active
          ? "border-accent bg-accent/10"
          : "border-border bg-bg-panel hover:bg-white/5"
      }`}
    >
      <div className="flex items-center gap-1.5 text-sm font-medium">
        {label}
        {recommended && (
          <span className="text-[9px] uppercase tracking-wide text-accent">
            ★
          </span>
        )}
      </div>
      <div className="text-[11px] text-gray-500 mt-0.5">{sub}</div>
    </button>
  );
}

function DetectedPill({ label, value }: { label: string; value: string }) {
  return (
    <span className="pill bg-emerald-500/10 border-emerald-500/30 text-emerald-300">
      <CheckCircle2 className="w-3 h-3" />
      <span className="text-gray-400">{label}:</span>
      <span className="text-emerald-200">{value}</span>
    </span>
  );
}

function hasAnyDetected(d: Detected, platform: Platform): boolean {
  if (platform === "ios") {
    return Boolean(
      d.ios_bundle_id || d.ios_deployment_target || d.ios_dependency_manager,
    );
  }
  if (platform === "android") {
    return Boolean(d.android_application_id || d.android_min_sdk);
  }
  return false;
}
