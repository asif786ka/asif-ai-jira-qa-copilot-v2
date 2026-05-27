/**
 * POST /api/feedback   — record one thumbs-up / thumbs-down on a test case.
 * GET  /api/feedback   — return aggregated stats (counts per provider, per
 *                        ticket, list of recently-thumbs-down'd codes).
 *
 * Storage: a JSONL log at FEEDBACK_LOG_PATH (defaults to
 * `${cwd}/.data/feedback.jsonl`). One line per event. No DB; this is the
 * lightest-possible production telemetry for v1. When the volume justifies
 * it, swap this file for a real store and keep the route shape.
 *
 * Privacy: we deliberately do not capture the LLM-generated test text
 * itself in the log — only IDs and the user's rating. The intent is signal
 * for prompt tuning, not regulatory-grade audit.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { FeedbackEventSchema, type FeedbackEvent } from "@jiraqa/core";
import { errorResponse, jsonResponse } from "@/lib/utils";

export const runtime = "nodejs";

const LOG_PATH =
  process.env.FEEDBACK_LOG_PATH ?? path.join(process.cwd(), ".data", "feedback.jsonl");

async function ensureLogDir() {
  await fs.mkdir(path.dirname(LOG_PATH), { recursive: true });
}

export async function POST(req: Request) {
  const parsed = FeedbackEventSchema.safeParse(
    await req.json().catch(() => null),
  );
  if (!parsed.success) {
    return errorResponse("Invalid feedback body", 400, parsed.error.message);
  }
  await ensureLogDir();
  const event = {
    ...parsed.data,
    recorded_at: new Date().toISOString(),
  };
  await fs.appendFile(LOG_PATH, JSON.stringify(event) + "\n", "utf-8");
  return jsonResponse({ ok: true });
}

export async function GET() {
  await ensureLogDir();
  let raw = "";
  try {
    raw = await fs.readFile(LOG_PATH, "utf-8");
  } catch {
    return jsonResponse({ events: [], stats: emptyStats() });
  }
  const lines = raw.split("\n").filter(Boolean);
  const events: (FeedbackEvent & { recorded_at?: string })[] = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line));
    } catch {
      // Skip malformed lines — never throw on read.
    }
  }
  return jsonResponse({ events, stats: computeStats(events) });
}

type Stats = {
  total: number;
  up: number;
  down: number;
  by_provider: Record<string, { up: number; down: number }>;
  approval_rate: number | null;
  // For dashboard "what does the team dislike?" — most-thumbed-down ticket IDs.
  worst_tickets: { ticket_id: string; down: number }[];
};

function emptyStats(): Stats {
  return {
    total: 0,
    up: 0,
    down: 0,
    by_provider: {},
    approval_rate: null,
    worst_tickets: [],
  };
}

function computeStats(events: FeedbackEvent[]): Stats {
  const stats: Stats = emptyStats();
  const downByTicket = new Map<string, number>();
  for (const e of events) {
    stats.total++;
    if (e.rating === "up") stats.up++;
    else stats.down++;
    const provKey = e.provider ?? "unknown";
    if (!stats.by_provider[provKey]) {
      stats.by_provider[provKey] = { up: 0, down: 0 };
    }
    if (e.rating === "up") stats.by_provider[provKey].up++;
    else stats.by_provider[provKey].down++;
    if (e.rating === "down") {
      downByTicket.set(e.ticket_id, (downByTicket.get(e.ticket_id) ?? 0) + 1);
    }
  }
  stats.approval_rate = stats.total > 0 ? stats.up / stats.total : null;
  stats.worst_tickets = [...downByTicket.entries()]
    .map(([ticket_id, down]) => ({ ticket_id, down }))
    .sort((a, b) => b.down - a.down)
    .slice(0, 10);
  return stats;
}
