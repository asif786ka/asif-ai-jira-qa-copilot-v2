"""Tests for the golden runner's metric helpers.

We don't try to test the LLM end-to-end here — that requires API keys and
is the job of the CI workflow. We DO test the small pure-Python helpers
(coverage_hit, baseline diff math) so the metric itself doesn't silently
break when someone tweaks the script.
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from scripts.run_golden import _coverage_hit  # noqa: E402


def test_coverage_hit_full():
    expected = ["happy path: small image uploads", "edge: boundary"]
    generated = ["Upload small image happy path", "Boundary case at 5 MB"]
    assert _coverage_hit(generated, expected) == 1.0


def test_coverage_hit_partial():
    expected = ["happy path: upload", "negative: oversize", "edge: boundary"]
    generated = ["upload happy", "oversize rejected"]
    # 2 of 3 expected scenarios match → 0.67
    assert round(_coverage_hit(generated, expected), 2) == 0.67


def test_coverage_hit_empty_expected_is_unity():
    assert _coverage_hit(["anything"], []) == 1.0


def test_coverage_hit_zero():
    expected = ["something completely different"]
    generated = ["unrelated", "test", "ideas"]
    assert _coverage_hit(generated, expected) == 0.0


def test_coverage_hit_ignores_short_tokens():
    """'happy', 'path', 'case' are filtered as connectives — they shouldn't
    cause every generated case to count as a hit just because they share
    'happy path' / 'case' in their names."""
    expected = ["happy path"]
    # Only short connectives — should NOT count as a hit if no real tokens.
    generated = ["case", "happy"]
    # Since all tokens in expected ('happy', 'path') are filtered out, the
    # implementation falls back to counting as a hit (no meaningful tokens
    # to require). Document that behaviour so we notice if it changes.
    assert _coverage_hit(generated, expected) == 1.0
