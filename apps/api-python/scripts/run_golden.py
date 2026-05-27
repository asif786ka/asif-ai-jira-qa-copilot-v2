"""Run the AI Jira QA Copilot generator against the golden ticket suite.

Usage:
  cd apps/api-python
  python scripts/run_golden.py                     # use default provider (OPENAI/GEMINI key)
  python scripts/run_golden.py --provider openai   # pin to a specific provider
  python scripts/run_golden.py --skip-judge        # skip the LLM-as-judge pass
  python scripts/run_golden.py --baseline.json     # compare to a previous run

What it measures, per golden ticket:
  - HTTP status  — pass/fail.
  - lint_pass    — did the deterministic output linter find zero errors?
  - lint_warns   — count of non-blocking warnings.
  - judge_score  — LLM-as-judge score (None if --skip-judge or unavailable).
  - coverage_hit — fraction of `expected_scenarios` from the golden file that
                   appear (substring match, case-insensitive) in any generated
                   test_scenario name. Cheap proxy for "did the generator
                   think of the obvious cases?".
  - latency_ms   — wall-clock time.

Output: a markdown table to stdout + a `golden-results.json` next to this
script for downstream tooling (CI diff vs. baseline).

Exit codes:
  0 — all golden tickets generated successfully and lint_pass=True for each.
  1 — at least one failure (HTTP error, lint failure, or schema error).
       CI workflow uses this to block PRs that regress generator quality.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
from pathlib import Path
from typing import Any

# Allow running this file directly: scripts/run_golden.py → import the api package.
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from api.judge import judge_generated_cases  # noqa: E402
from api.llm import LLMCompletionRequest, resolve_llm_provider  # noqa: E402
from api.models import GenerateResponse, JiraTicket, Platform  # noqa: E402
from api.output_validation import errors_only, lint_generated_cases  # noqa: E402
from api.prompt import build_system_prompt, build_user_prompt  # noqa: E402


GOLDEN_DIR = ROOT / "golden"


def _load_goldens() -> list[dict[str, Any]]:
    files = sorted(GOLDEN_DIR.glob("*.json"))
    return [json.loads(f.read_text()) for f in files]


def _coverage_hit(generated_scenarios: list[str], expected: list[str]) -> float:
    """Fraction of expected scenarios that match at least one generated case.

    Naive substring match on a normalised token set — good enough for a coarse
    regression signal. Tightening this is a follow-up (LLM-judged overlap).
    """
    if not expected:
        return 1.0
    gen_lower = [s.lower() for s in generated_scenarios]
    hits = 0
    for want in expected:
        # Strip pronouns / connectives; check if any meaningful token is present.
        tokens = [
            t for t in want.lower().replace(":", " ").replace("/", " ").split()
            if len(t) > 3 and t not in {"happy", "path", "case", "with", "from", "into"}
        ]
        if not tokens:
            hits += 1
            continue
        if any(any(tok in g for tok in tokens) for g in gen_lower):
            hits += 1
    return hits / len(expected)


async def _run_one(
    golden: dict[str, Any],
    *,
    provider: str | None,
    skip_judge: bool,
) -> dict[str, Any]:
    ticket = JiraTicket(**golden["ticket"])
    platform = Platform(golden["platform"])
    expected = golden.get("expected_scenarios") or []

    t0 = time.perf_counter()
    row: dict[str, Any] = {
        "name": golden["name"],
        "platform": platform.value,
        "lint_pass": False,
        "lint_warns": 0,
        "judge_score": None,
        "coverage_hit": 0.0,
        "latency_ms": 0,
        "error": None,
    }

    try:
        llm = resolve_llm_provider(provider)
    except Exception as e:
        row["error"] = f"no provider: {e}"
        row["latency_ms"] = int((time.perf_counter() - t0) * 1000)
        return row

    system_prompt = build_system_prompt(platform, count_hint=5)
    user_prompt = build_user_prompt(ticket, platform, None)
    try:
        completion = await llm.complete(
            LLMCompletionRequest(
                system_prompt=system_prompt,
                user_prompt=user_prompt,
                temperature=0.3,
                json_mode=True,
            )
        )
    except Exception as e:
        row["error"] = f"llm error: {e}"
        row["latency_ms"] = int((time.perf_counter() - t0) * 1000)
        return row

    try:
        parsed = json.loads(completion.text)
    except json.JSONDecodeError as e:
        row["error"] = f"bad JSON: {e}"
        row["latency_ms"] = int((time.perf_counter() - t0) * 1000)
        return row

    try:
        response = GenerateResponse(
            ticket_id=parsed.get("ticket_id") or ticket.ticket_id,
            summary=parsed.get("summary") or ticket.summary,
            platform=platform,
            provider=llm.name,
            backend="python",
            generated_test_cases=parsed.get("generated_test_cases", []),
        )
    except Exception as e:
        row["error"] = f"schema error: {e}"
        row["latency_ms"] = int((time.perf_counter() - t0) * 1000)
        return row

    lint = lint_generated_cases(response.generated_test_cases, platform)
    row["lint_pass"] = len(errors_only(lint)) == 0
    row["lint_warns"] = len(lint)

    if not skip_judge:
        verdict = await judge_generated_cases(ticket, platform, response.generated_test_cases)
        row["judge_score"] = verdict.score

    row["coverage_hit"] = round(
        _coverage_hit(
            [tc.test_scenario for tc in response.generated_test_cases], expected
        ),
        2,
    )
    row["latency_ms"] = int((time.perf_counter() - t0) * 1000)
    return row


def _print_table(rows: list[dict[str, Any]]) -> None:
    header = (
        f"| {'Golden':<32} | {'Plat':<7} | Lint | Warns | Judge | Cov  | Latency | Notes"
    )
    print(header)
    print("|" + "-" * (len(header) - 1))
    for r in rows:
        notes = r["error"] or ""
        lint = "PASS" if r["lint_pass"] else "FAIL"
        judge = f"{r['judge_score']:>3}/100" if r["judge_score"] is not None else " -   "
        print(
            f"| {r['name']:<32} | {r['platform']:<7} | {lint:<4} | {r['lint_warns']:<5} "
            f"| {judge} | {r['coverage_hit']:<4} | {r['latency_ms']:>5} ms | {notes}"
        )


def _maybe_diff_baseline(rows: list[dict[str, Any]], baseline_path: Path | None) -> int:
    """Returns extra failures (regressions) compared to baseline. 0 if no baseline."""
    if not baseline_path or not baseline_path.exists():
        return 0
    try:
        baseline = json.loads(baseline_path.read_text())
    except Exception:
        print(f"⚠️  Could not parse baseline {baseline_path}, skipping diff.")
        return 0
    by_name = {r["name"]: r for r in rows}
    regressions = 0
    print("\nRegressions vs baseline:")
    for b in baseline.get("rows", []):
        n = b["name"]
        cur = by_name.get(n)
        if not cur:
            continue
        if b.get("judge_score") and cur.get("judge_score"):
            if cur["judge_score"] + 5 < b["judge_score"]:  # 5-pt tolerance
                regressions += 1
                print(f"  - {n}: judge {b['judge_score']} → {cur['judge_score']}")
        if b.get("coverage_hit", 0) > cur.get("coverage_hit", 0) + 0.1:
            regressions += 1
            print(f"  - {n}: coverage {b['coverage_hit']} → {cur['coverage_hit']}")
        if b.get("lint_pass") and not cur.get("lint_pass"):
            regressions += 1
            print(f"  - {n}: lint PASS → FAIL")
    if regressions == 0:
        print("  none.")
    return regressions


async def _main_async(args: argparse.Namespace) -> int:
    goldens = _load_goldens()
    if not goldens:
        print(f"No golden files found in {GOLDEN_DIR}. Aborting.")
        return 1

    rows: list[dict[str, Any]] = []
    for g in goldens:
        row = await _run_one(g, provider=args.provider, skip_judge=args.skip_judge)
        rows.append(row)

    _print_table(rows)

    out = ROOT / "golden-results.json"
    out.write_text(json.dumps({"rows": rows}, indent=2))
    print(f"\nWrote {out}")

    regressions = _maybe_diff_baseline(rows, Path(args.baseline) if args.baseline else None)

    hard_failures = [r for r in rows if r["error"] or not r["lint_pass"]]
    if hard_failures:
        print(f"\n❌ {len(hard_failures)} golden ticket(s) failed.")
        return 1
    if regressions:
        print(f"\n❌ {regressions} regression(s) vs baseline.")
        return 1
    print("\n✅ All golden tickets passed.")
    return 0


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--provider", default=None, help="openai | gemini | anthropic")
    p.add_argument("--skip-judge", action="store_true", help="skip LLM-as-judge pass")
    p.add_argument(
        "--baseline",
        default=None,
        help="path to a previous golden-results.json to diff against",
    )
    args = p.parse_args()

    # Refuse to run without a key — otherwise the report is meaningless.
    if not any(
        os.environ.get(k) for k in ("OPENAI_API_KEY", "GEMINI_API_KEY", "ANTHROPIC_API_KEY")
    ):
        print(
            "❌ No LLM API key set. Set OPENAI_API_KEY, GEMINI_API_KEY, or "
            "ANTHROPIC_API_KEY before running the golden suite."
        )
        return 1

    return asyncio.run(_main_async(args))


if __name__ == "__main__":
    sys.exit(main())
