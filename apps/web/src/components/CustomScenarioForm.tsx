"use client";

/**
 * Phase 12.1 — Custom scenario form.
 *
 * Alternative entry point to the Jira-driven flow. Users describe what they
 * want tested, optionally attach 1–3 UI screenshots, and pick a platform.
 *
 * Internally the scenario is converted to a JiraTicket shape so the rest
 * of the generation pipeline (system/user prompts, validation, code-gen,
 * PR creation) doesn't change.
 *
 * Cost disclosure (12.5) is rendered inline next to the screenshot uploader
 * so the user sees the cost impact at the moment they add visuals.
 */

import { useEffect, useMemo, useState } from "react";
import type { JiraTicket, Platform, Screenshot } from "@jiraqa/core";
import { Apple, Globe, Smartphone, Image as ImageIcon, X } from "lucide-react";

const MAX_BYTES_PER_FILE = 5 * 1024 * 1024; // 5 MB encoded
const MAX_FILES = 3;

export type CustomScenarioOutput = {
  ticket: JiraTicket;
  platform: Platform;
  screenshots: Screenshot[];
};

type Props = {
  onChange: (output: CustomScenarioOutput | null) => void;
};

export function CustomScenarioForm({ onChange }: Props) {
  const [title, setTitle] = useState("");
  const [jiraLink, setJiraLink] = useState("");
  const [description, setDescription] = useState("");
  const [preconditions, setPreconditions] = useState("");
  const [expected, setExpected] = useState("");
  const [platform, setPlatform] = useState<Platform>("ios");
  const [screenshots, setScreenshots] = useState<Screenshot[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Push the current scenario up to the parent whenever any field changes.
  // useEffect (not useMemo) because we're producing a side-effect (parent
  // setState), not a memoised return value. Running during render is a
  // React anti-pattern.
  // The parent treats `null` as "form is incomplete, disable Generate".
  useEffect(() => {
    if (!title.trim() || !expected.trim()) {
      onChange(null);
      return;
    }
    // Prefer Jira link if provided; otherwise derive a readable slug from
    // the title so file/branch names look like CUSTOM-login-empty-pwd
    // rather than CUSTOM-MEF0XX.
    const titleSlug = title
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);
    const ticketId =
      jiraLink.trim() || `CUSTOM-${titleSlug || Date.now().toString(36)}`;

    // Acceptance criteria — one per line of "Expected behaviour".
    // That field is where users write the testable outcomes; preconditions
    // are *setup state*, not assertions. (Pre-fix this mapping was inverted
    // which made the validator complain when the user actually had
    // perfectly testable Expected lines.)
    const acceptance_criteria = expected
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);

    // Description — compose every textarea the user filled so the LLM
    // (and the >=30-char rule) sees the full picture. Falls back to just
    // the Expected text when nothing else is filled.
    const preconditionsList = preconditions
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    const descriptionParts: string[] = [];
    if (expected.trim()) {
      descriptionParts.push(`Expected behaviour:\n${expected.trim()}`);
    }
    if (preconditionsList.length > 0) {
      descriptionParts.push(
        `Preconditions:\n${preconditionsList.map((p) => `- ${p}`).join("\n")}`,
      );
    }
    if (description.trim()) {
      descriptionParts.push(`Additional context:\n${description.trim()}`);
    }
    const composedDescription =
      descriptionParts.join("\n\n") || expected.trim();

    const ticket: JiraTicket = {
      ticket_id: ticketId,
      summary: title.trim(),
      description: composedDescription,
      acceptance_criteria,
      issue_type: "story",
      priority: "medium",
      component: "",
      labels: ["custom-scenario"],
      environment: "",
    };
    onChange({ ticket, platform, screenshots });
  }, [
    title,
    jiraLink,
    description,
    preconditions,
    expected,
    platform,
    screenshots,
    onChange,
  ]);

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploadError(null);

    const newOnes: Screenshot[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (!file) continue;
      if (screenshots.length + newOnes.length >= MAX_FILES) {
        setUploadError(`Maximum ${MAX_FILES} screenshots.`);
        break;
      }
      if (!file.type.startsWith("image/")) {
        setUploadError(`"${file.name}" isn't an image.`);
        continue;
      }
      if (file.size > MAX_BYTES_PER_FILE) {
        setUploadError(
          `"${file.name}" is ${(file.size / 1024 / 1024).toFixed(1)} MB — max is 5 MB.`,
        );
        continue;
      }
      const dataUrl = await fileToDataUrl(file);
      newOnes.push({ data_url: dataUrl, label: file.name });
    }
    if (newOnes.length > 0) {
      setScreenshots((prev) => [...prev, ...newOnes]);
    }
  }

  function removeScreenshot(idx: number) {
    setScreenshots((prev) => prev.filter((_, i) => i !== idx));
  }

  // Phase 12.5 — cost preview.
  // Text-only generation ~= $0.08 on Gemini Flash (current default).
  // Each image adds ~1500 input tokens. With Anthropic Sonnet vision routing
  // the per-screenshot cost is roughly $0.10 (very rough — actual depends
  // on output length too).
  const estimatedCost = useMemo(() => {
    if (screenshots.length === 0) return null;
    const base = 0.08;
    const perImage = 0.1;
    return base + screenshots.length * perImage;
  }, [screenshots.length]);

  return (
    <div className="card space-y-4">
      <div>
        <label className="text-xs text-gray-400">
          Title <span className="text-red-400">*</span>
        </label>
        <input
          className="input mt-1"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Upload profile picture validates file size"
          maxLength={140}
        />
      </div>

      <div>
        <label className="text-xs text-gray-400">
          Jira link / ID <span className="text-gray-500">(optional)</span>
        </label>
        <input
          className="input mt-1"
          value={jiraLink}
          onChange={(e) => setJiraLink(e.target.value)}
          placeholder="KAN-42 or https://acme.atlassian.net/browse/KAN-42"
        />
      </div>

      <div>
        <label className="text-xs text-gray-400">
          Preconditions <span className="text-gray-500">(one per line)</span>
        </label>
        <textarea
          className="input mt-1 font-mono text-[12px]"
          rows={3}
          value={preconditions}
          onChange={(e) => setPreconditions(e.target.value)}
          placeholder="User is logged in&#10;User is on the profile settings screen"
        />
      </div>

      <div>
        <label className="text-xs text-gray-400">
          Expected behaviour <span className="text-red-400">*</span>{" "}
          <span className="text-gray-500">
            (one acceptance criterion per line — need at least 2)
          </span>
        </label>
        <textarea
          className="input mt-1 font-mono text-[12px]"
          rows={5}
          value={expected}
          onChange={(e) => setExpected(e.target.value)}
          placeholder={
            "When the user taps Upload with a 10 MB image, the app rejects it and shows 'File too large, max 5 MB' within 1s.\n" +
            "When the user taps OK on the error dialog, focus returns to the Upload button.\n" +
            "When the user is offline and taps Upload, no network request is made and an inline 'No internet' error appears."
          }
        />
      </div>

      <div>
        <label className="text-xs text-gray-400">
          Additional context <span className="text-gray-500">(optional)</span>
        </label>
        <textarea
          className="input mt-1"
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Notes, links to designs, environment details..."
        />
      </div>

      <div>
        <label className="text-xs text-gray-400">Target platform</label>
        <div className="grid grid-cols-3 gap-2 mt-1">
          <PlatformChip
            value="android"
            current={platform}
            onPick={setPlatform}
            icon={<Smartphone className="w-4 h-4" />}
          />
          <PlatformChip
            value="ios"
            current={platform}
            onPick={setPlatform}
            icon={<Apple className="w-4 h-4" />}
          />
          <PlatformChip
            value="web"
            current={platform}
            onPick={setPlatform}
            icon={<Globe className="w-4 h-4" />}
          />
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="text-xs text-gray-400">
            Screenshots <span className="text-gray-500">(optional, up to 3)</span>
          </label>
          {estimatedCost !== null && (
            <span className="text-[11px] text-amber-300">
              vision cost ≈ ${estimatedCost.toFixed(2)} / generation
            </span>
          )}
        </div>

        {screenshots.length > 0 && (
          <div className="grid grid-cols-3 gap-2 mb-2">
            {screenshots.map((s, i) => (
              <div
                key={i}
                className="relative rounded border border-border overflow-hidden bg-bg-panel"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={s.data_url}
                  alt={s.label ?? `screenshot ${i + 1}`}
                  className="w-full h-24 object-cover"
                />
                <button
                  onClick={() => removeScreenshot(i)}
                  className="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/70 text-white flex items-center justify-center hover:bg-red-600"
                  aria-label={`Remove screenshot ${i + 1}`}
                >
                  <X className="w-3 h-3" />
                </button>
                <div className="text-[9px] text-gray-400 px-1 py-0.5 truncate">
                  {s.label ?? `image ${i + 1}`}
                </div>
              </div>
            ))}
          </div>
        )}

        {screenshots.length < MAX_FILES && (
          <label className="btn-ghost cursor-pointer inline-flex">
            <ImageIcon className="w-3.5 h-3.5" /> Add screenshot
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              multiple
              className="hidden"
              onChange={(e) => {
                handleFiles(e.target.files);
                // Reset so the same file can be re-added if removed.
                e.target.value = "";
              }}
            />
          </label>
        )}

        {uploadError && (
          <div className="text-[11px] text-red-400 mt-1">{uploadError}</div>
        )}

        <p className="text-[11px] text-gray-500 mt-2 leading-relaxed">
          Screenshots are sent to your selected LLM provider per their data
          policies. Don't upload anything you wouldn't be comfortable sharing
          with that vendor. We don't persist images server-side.
        </p>
      </div>
    </div>
  );
}

function PlatformChip({
  value,
  current,
  onPick,
  icon,
}: {
  value: Platform;
  current: Platform;
  onPick: (p: Platform) => void;
  icon: React.ReactNode;
}) {
  const active = value === current;
  return (
    <button
      onClick={() => onPick(value)}
      className={`flex flex-col items-center gap-1 px-2 py-2 rounded-lg border text-xs transition ${
        active
          ? "border-accent bg-accent/10 text-accent"
          : "border-border bg-bg-panel hover:bg-white/5 text-gray-300"
      }`}
    >
      {icon}
      <span className="capitalize">{value}</span>
    </button>
  );
}

async function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("FileReader error"));
    reader.readAsDataURL(file);
  });
}
