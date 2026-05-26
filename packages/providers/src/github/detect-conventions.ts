/**
 * @module @jiraqa/providers/github/detect-conventions
 *
 * Pre-fills Phase 11 RepoConventions with smart defaults derived from the
 * main app's repo contents. The convention wizard in the UI then shows
 * these as the pre-selected answers — the user can change anything, but
 * most won't need to.
 *
 * What we detect:
 *   • iOS bundle identifier            — from Info.plist or Package.swift
 *   • iOS deployment target            — from project settings / Package.swift
 *   • iOS dependency manager           — presence of Podfile / Package.swift / Tuist/
 *   • Android applicationId            — from build.gradle / build.gradle.kts
 *   • Android minSdk                   — from build.gradle / build.gradle.kts
 *
 * Note: we deliberately do NOT recommend a test framework here — that's
 * the user's primary choice in the wizard, and pre-selecting it would
 * bias the UX. We only fill in factual project metadata.
 */

import type { Platform, RepoContext } from "@jiraqa/core";

export type DetectedConventions = {
  // iOS
  ios_bundle_id?: string;
  ios_deployment_target?: string;
  ios_dependency_manager?: "spm" | "cocoapods" | "carthage" | "tuist" | "xcodegen";
  // Android
  android_application_id?: string;
  android_min_sdk?: number;
};

/**
 * Detect from an already-built RepoContext (which includes key_files excerpts).
 * Pure function — no network calls, just regex over the file contents we
 * already pulled for the LLM prompt.
 */
export function detectConventionsFromContext(
  context: RepoContext,
  platform: Platform,
): DetectedConventions {
  const out: DetectedConventions = {};
  const fileMap = new Map(context.key_files?.map((f) => [f.path, f.excerpt]) ?? []);
  const allPaths = context.file_tree_sample ?? [];

  if (platform === "ios") {
    // Dependency manager
    if (allPaths.some((p) => p === "Podfile" || p.endsWith("/Podfile"))) {
      out.ios_dependency_manager = "cocoapods";
    } else if (
      allPaths.some((p) => p === "Tuist" || p.startsWith("Tuist/") || p.includes("/Tuist/"))
    ) {
      out.ios_dependency_manager = "tuist";
    } else if (
      allPaths.some((p) => p === "project.yml" || p.endsWith("/project.yml"))
    ) {
      out.ios_dependency_manager = "xcodegen";
    } else if (
      allPaths.some((p) => p === "Cartfile" || p.endsWith("/Cartfile"))
    ) {
      out.ios_dependency_manager = "carthage";
    } else if (
      allPaths.some((p) => p === "Package.swift" || p.endsWith("/Package.swift"))
    ) {
      out.ios_dependency_manager = "spm";
    }

    // Bundle ID — pbxproj is the authoritative source. We try it first,
    // then fall back to a literal value in Info.plist.
    for (const [path, excerpt] of fileMap) {
      if (/\.pbxproj$/i.test(path) && !out.ios_bundle_id) {
        // Match: PRODUCT_BUNDLE_IDENTIFIER = "com.acme.app";
        //   or: PRODUCT_BUNDLE_IDENTIFIER = com.acme.app;
        // Skip $(...) variable references — we want a real value.
        const matches = Array.from(
          excerpt.matchAll(/PRODUCT_BUNDLE_IDENTIFIER\s*=\s*["']?([\w.\-]+)["']?\s*;/g),
        );
        for (const m of matches) {
          const v = m[1];
          if (v && !v.includes("$(") && v.includes(".")) {
            // Prefer the first non-test, non-extension bundle id.
            if (!/\.(test|tests|UITests|UITest|Tests|widget|appex)$/i.test(v)) {
              out.ios_bundle_id = v;
              break;
            }
            // Fall back to the first match even if it looks like a test target
            // — better than nothing.
            if (!out.ios_bundle_id) out.ios_bundle_id = v;
          }
        }
      }
    }
    // Info.plist is the secondary source. Modern projects use a variable
    // reference here, but older / simpler projects hard-code the bundle id.
    if (!out.ios_bundle_id) {
      for (const [path, excerpt] of fileMap) {
        if (!/Info\.plist$/i.test(path)) continue;
        const m = excerpt.match(
          /<key>\s*CFBundleIdentifier\s*<\/key>\s*<string>([^<]+)<\/string>/,
        );
        if (m?.[1]) {
          const v = m[1].trim();
          // Skip variable references; keep concrete identifiers only.
          if (!v.includes("$(") && v.includes(".")) {
            out.ios_bundle_id = v;
            break;
          }
        }
      }
    }

    // Deployment target — IPHONEOS_DEPLOYMENT_TARGET in pbxproj, or
    // platforms: .iOS("17.0") in Package.swift.
    for (const [, excerpt] of fileMap) {
      const m1 = excerpt.match(/IPHONEOS_DEPLOYMENT_TARGET\s*=\s*([0-9.]+)/);
      if (m1?.[1]) {
        out.ios_deployment_target = m1[1];
        break;
      }
      const m2 = excerpt.match(/\.iOS\(\s*"?([0-9]+(?:\.[0-9]+)?)/);
      if (m2?.[1]) {
        out.ios_deployment_target = m2[1];
        break;
      }
    }
  }

  if (platform === "android") {
    for (const [path, excerpt] of fileMap) {
      if (!/build\.gradle(\.kts)?$/i.test(path)) continue;

      // applicationId "com.acme.app"  /  applicationId = "com.acme.app"
      const appIdMatch =
        excerpt.match(/applicationId\s*=?\s*["']([\w.]+)["']/) ?? null;
      if (appIdMatch?.[1]) out.android_application_id = appIdMatch[1];

      // minSdk 24  /  minSdkVersion 24  /  minSdk = 24
      const minSdkMatch =
        excerpt.match(/minSdk(?:Version)?\s*=?\s*(\d{2,3})/) ?? null;
      if (minSdkMatch?.[1]) out.android_min_sdk = Number(minSdkMatch[1]);

      if (out.android_application_id && out.android_min_sdk) break;
    }
  }

  return out;
}
