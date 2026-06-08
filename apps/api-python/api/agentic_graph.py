"""Agentic SDLC pipeline — multi-agent LangGraph workflow.

This is the v2 path for /pyapi/agentic-generate. It composes five specialised
agents into a state machine that mirrors a real AI-assisted SDLC stage rather
than a single prompt-to-test-cases LLM call.

Pipeline (supervisor-worker hybrid)

    [ readiness ] ──gate──► [ requirements ] ──► [ generator ] ──► [ reviewer ]
          │ fail                                          ▲              │
          ▼                                               └─── repair ◄──┤
    end (422)                                                            │
                                                                         ▼
                                                                    [ scorer ]
                                                                         │
                                                                         ▼
                                                                       END

Why each agent exists
─────────────────────
1. ReadinessAgent       — gates the pipeline on input quality. Reuses
                          deterministic rules + LLM rubric from validation.py.
                          Saves spend by short-circuiting bad tickets.

2. RequirementExtractor — converts free-form ticket prose into a structured
                          requirements artefact (testable behaviours,
                          implicit edges, NFRs). Acts as the "BA" agent in
                          the SDLC analogy.

3. TestGeneratorAgent   — produces test cases grounded in BOTH the ticket and
                          the extracted requirements. Reuses the existing
                          prompt builder + provider interface.

4. QualityReviewerAgent — runs deterministic R1–R5 lint over the generated
                          batch. If errors are found, routes back to the
                          generator with structured repair guidance — bounded
                          by MAX_REPAIRS to prevent runaway loops.

5. ScorerAgent          — soft LLM-as-judge score with cross-family model.
                          Never blocks output; surfaces a numeric quality
                          rating + per-case flags to the UI.

Design notes
────────────
* State is a TypedDict so each agent writes only its own keys; no reducer
  cascades, no shared-mutable-dict surprises.
* The graph is async end-to-end — every LLM call uses the existing
  LLMProvider.complete() coroutine.
* Repair is implemented as a conditional edge, not a node mutation, so the
  graph remains acyclic in concept (a bounded loop on a single edge pair).
* The graph object is built once at import-time and reused across requests.
  LangGraph's compiled graphs are thread-safe for stateless invocation.

Run locally
───────────
    POST /pyapi/agentic-generate
    {
      "ticket": { ... },
      "platform": "android",
      "repo_context": { ... },
      "provider": "openai",
      "count_hint": 5
    }
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any, TypedDict

from langgraph.graph import END, START, StateGraph
from pydantic import ValidationError

from .judge import QualityScore, judge_generated_cases
from .llm import LLMCompletionRequest, resolve_llm_provider
from .models import (
    GenerateResponse,
    JiraTicket,
    Platform,
    RepoContext,
    TestCase,
    TicketValidationIssue,
    TicketValidationResult,
)
from .output_validation import errors_only, lint_generated_cases
from .prompt import build_system_prompt, build_user_prompt
from .validation import validate_ticket

logger = logging.getLogger("jiraqa.python.agentic")


# ────────────────────────────────────────────────────────────────────────────
# Tunables
# ────────────────────────────────────────────────────────────────────────────

# How many times the reviewer can ask the generator to try again before we
# accept the best-effort batch. Bounds the agentic loop; protects token spend.
MAX_REPAIRS = 2

# Temperature for the "BA" agent. Lower than the generator because we want
# stable extraction, not creativity.
REQUIREMENTS_TEMPERATURE = 0.1
GENERATOR_TEMPERATURE = 0.3
REPAIR_TEMPERATURE = 0.2


# ────────────────────────────────────────────────────────────────────────────
# Graph state — every agent reads from / writes to this TypedDict.
# total=False means every key is optional; downstream agents only see what
# upstream agents have populated, which makes partial-failure debugging easy.
# ────────────────────────────────────────────────────────────────────────────


class ExtractedRequirements(TypedDict, total=False):
    """Structured artefact produced by the RequirementExtractor agent."""

    primary_behaviour: str
    happy_paths: list[str]
    negative_paths: list[str]
    edge_cases: list[str]
    non_functional: list[str]  # perf, a11y, security touchpoints
    out_of_scope: list[str]


class AgenticState(TypedDict, total=False):
    # ── Inputs (set once by the entrypoint)
    ticket: JiraTicket
    platform: Platform
    repo_context: RepoContext | None
    provider_name: str | None
    count_hint: int

    # ── Populated by ReadinessAgent
    readiness: TicketValidationResult

    # ── Populated by RequirementExtractor
    requirements: ExtractedRequirements

    # ── Populated by TestGeneratorAgent (per attempt)
    candidate_response: GenerateResponse
    repair_attempts: int
    repair_feedback: list[TicketValidationIssue]

    # ── Populated by QualityReviewerAgent
    lint_issues: list[TicketValidationIssue]

    # ── Populated by ScorerAgent
    quality: QualityScore

    # ── Final
    final_payload: dict[str, Any]
    error: str  # set on terminal failure; main.py turns this into a 4xx/5xx


# ────────────────────────────────────────────────────────────────────────────
# Agent 1 — Readiness
# ────────────────────────────────────────────────────────────────────────────


async def readiness_agent(state: AgenticState) -> AgenticState:
    """Gate the pipeline on input ticket quality.

    Delegates to validate_ticket() so we have a single source of truth for
    the rules. The LLM rubric is ON here (different from /generate) because
    in the agentic path we trade a small extra LLM call for higher input
    confidence — bad tickets cost far more downstream.
    """
    result = await validate_ticket(
        state["ticket"],
        state["platform"],
        use_llm_rubric=True,
        provider=state.get("provider_name"),
    )
    return {"readiness": result}


def route_after_readiness(state: AgenticState) -> str:
    """Conditional edge — block at the gate or proceed."""
    if not state["readiness"].passed:
        return "end_with_error"
    return "extract_requirements"


# ────────────────────────────────────────────────────────────────────────────
# Agent 2 — Requirement Extractor (the BA agent)
# ────────────────────────────────────────────────────────────────────────────


_REQUIREMENTS_SYSTEM = """You are a senior business analyst preparing a Jira ticket for QA.
Extract a structured requirements artefact from the ticket. Be exhaustive about
edges and negative paths; QA will only test what you list.

Return ONLY a JSON object with this exact shape:
{
  "primary_behaviour": "one sentence summary of what the change does",
  "happy_paths": ["..."],
  "negative_paths": ["..."],
  "edge_cases": ["..."],
  "non_functional": ["perf / a11y / security touchpoints"],
  "out_of_scope": ["things the ticket explicitly excludes"]
}
"""


def _ticket_as_text(ticket: JiraTicket) -> str:
    lines = [
        f"Ticket: {ticket.ticket_id}",
        f"Summary: {ticket.summary}",
        f"Issue type: {ticket.issue_type}",
        f"Priority: {ticket.priority}",
        f"Description:\n{ticket.description}",
    ]
    if ticket.acceptance_criteria:
        lines.append("Acceptance Criteria:")
        for i, ac in enumerate(ticket.acceptance_criteria, 1):
            lines.append(f"  {i}. {ac}")
    if ticket.environment:
        lines.append(f"Environment: {ticket.environment}")
    return "\n".join(lines)


async def requirement_extractor_agent(state: AgenticState) -> AgenticState:
    """LLM-backed extraction of structured testable requirements."""
    llm = resolve_llm_provider(state.get("provider_name"))
    user = _ticket_as_text(state["ticket"])
    try:
        resp = await llm.complete(
            LLMCompletionRequest(
                system_prompt=_REQUIREMENTS_SYSTEM,
                user_prompt=user,
                temperature=REQUIREMENTS_TEMPERATURE,
                json_mode=True,
                max_tokens=900,
            )
        )
        parsed = json.loads(resp.text)
    except Exception as e:  # noqa: BLE001
        logger.warning("Requirement extractor failed; falling back to AC list: %s", e)
        parsed = {
            "primary_behaviour": state["ticket"].summary,
            "happy_paths": list(state["ticket"].acceptance_criteria or []),
            "negative_paths": [],
            "edge_cases": [],
            "non_functional": [],
            "out_of_scope": [],
        }

    requirements: ExtractedRequirements = {
        "primary_behaviour": parsed.get("primary_behaviour", "") or "",
        "happy_paths": list(parsed.get("happy_paths") or []),
        "negative_paths": list(parsed.get("negative_paths") or []),
        "edge_cases": list(parsed.get("edge_cases") or []),
        "non_functional": list(parsed.get("non_functional") or []),
        "out_of_scope": list(parsed.get("out_of_scope") or []),
    }
    return {"requirements": requirements}


# ────────────────────────────────────────────────────────────────────────────
# Agent 3 — Test Generator
# ────────────────────────────────────────────────────────────────────────────


def _augment_user_prompt(base: str, state: AgenticState) -> str:
    """Inject extracted requirements + any repair feedback into the user prompt."""
    req = state.get("requirements") or {}
    feedback = state.get("repair_feedback") or []

    extra = ["\n\n--- Extracted requirements (from BA agent) ---"]
    if req.get("primary_behaviour"):
        extra.append(f"Primary behaviour: {req['primary_behaviour']}")
    for key in ("happy_paths", "negative_paths", "edge_cases", "non_functional", "out_of_scope"):
        items = req.get(key) or []
        if items:
            extra.append(f"{key.replace('_', ' ').title()}:")
            for it in items:
                extra.append(f"  - {it}")

    if feedback:
        extra.append("\n--- Reviewer feedback from previous attempt — fix these ---")
        for f in feedback:
            extra.append(f"  [{f.code}] {f.message}")
            if f.hint:
                extra.append(f"      hint: {f.hint}")

    return base + "\n".join(extra)


async def test_generator_agent(state: AgenticState) -> AgenticState:
    """Produce a TestCase batch, grounded in ticket + requirements + repair feedback."""
    llm = resolve_llm_provider(state.get("provider_name"))

    system_prompt = build_system_prompt(state["platform"], state.get("count_hint", 5))
    base_user = build_user_prompt(state["ticket"], state["platform"], state.get("repo_context"))
    user_prompt = _augment_user_prompt(base_user, state)

    try:
        completion = await llm.complete(
            LLMCompletionRequest(
                system_prompt=system_prompt,
                user_prompt=user_prompt,
                temperature=REPAIR_TEMPERATURE if state.get("repair_attempts") else GENERATOR_TEMPERATURE,
                json_mode=True,
            )
        )
    except Exception as e:  # noqa: BLE001
        return {"error": f"LLM call failed: {e}"}

    try:
        parsed = json.loads(completion.text)
    except json.JSONDecodeError:
        return {"error": "LLM returned invalid JSON"}

    candidate = {
        "ticket_id": parsed.get("ticket_id") or state["ticket"].ticket_id,
        "summary": parsed.get("summary") or state["ticket"].summary,
        "platform": state["platform"],
        "provider": llm.name,
        "backend": "python-agentic",
        "generated_test_cases": parsed.get("generated_test_cases", []),
    }
    try:
        response = GenerateResponse(**candidate)
    except ValidationError as e:
        return {"error": f"LLM output failed schema validation: {e}"}

    return {"candidate_response": response}


# ────────────────────────────────────────────────────────────────────────────
# Agent 4 — Quality Reviewer (with repair loop)
# ────────────────────────────────────────────────────────────────────────────


async def quality_reviewer_agent(state: AgenticState) -> AgenticState:
    """Lint the batch with R1–R5; collect issues for the conditional edge."""
    response = state.get("candidate_response")
    if response is None:
        return {"lint_issues": []}
    issues = lint_generated_cases(response.generated_test_cases, response.platform)
    return {"lint_issues": issues}


def route_after_review(state: AgenticState) -> str:
    """Decide between repair / score / give up.

    Loop bound is MAX_REPAIRS — after that, we hand back whatever the
    generator produced. The reviewer's job is to nudge quality, not to
    block forever.
    """
    if state.get("error"):
        return "end_with_error"

    hard = errors_only(state.get("lint_issues") or [])
    if not hard:
        return "score"

    attempts = state.get("repair_attempts", 0)
    if attempts >= MAX_REPAIRS:
        # Bounded loop exhausted — accept best effort, let the judge flag it.
        return "score"

    return "repair"


def repair_router_state_update(state: AgenticState) -> AgenticState:
    """Tiny synthetic node — bumps attempt count + plumbs feedback to the generator."""
    return {
        "repair_attempts": state.get("repair_attempts", 0) + 1,
        "repair_feedback": errors_only(state.get("lint_issues") or []),
    }


# ────────────────────────────────────────────────────────────────────────────
# Agent 5 — Scorer (soft signal)
# ────────────────────────────────────────────────────────────────────────────


async def scorer_agent(state: AgenticState) -> AgenticState:
    """Run cross-family LLM-as-judge. Never blocks; pure enrichment."""
    response = state.get("candidate_response")
    if response is None:
        return {}
    try:
        quality = await judge_generated_cases(
            state["ticket"],
            response.platform,
            response.generated_test_cases,
            generator_provider=response.provider,
        )
    except Exception as e:  # noqa: BLE001
        logger.info("Scorer skipped: %s", e)
        return {"quality": QualityScore()}
    return {"quality": quality}


# ────────────────────────────────────────────────────────────────────────────
# Final assembly node — produces the JSON the route returns.
# ────────────────────────────────────────────────────────────────────────────


def finalize_node(state: AgenticState) -> AgenticState:
    response = state.get("candidate_response")
    if response is None:
        return {
            "final_payload": {
                "error": state.get("error", "Unknown failure"),
                "code": "agentic_pipeline_failed",
            }
        }

    payload = response.model_dump(mode="json")

    # Surface the BA agent's artefact so the UI / auditor sees the
    # intermediate reasoning — important for AI-DLC audit trails.
    payload["requirements"] = state.get("requirements", {})

    # Lint issues become warnings (we only reached this node because hard
    # errors were either zero or exhausted via repair).
    lint_issues = state.get("lint_issues") or []
    if lint_issues:
        payload["lint_warnings"] = [i.model_dump(mode="json") for i in lint_issues]

    payload["repair_attempts"] = state.get("repair_attempts", 0)

    quality = state.get("quality")
    if quality:
        payload["quality"] = quality.model_dump(mode="json")

    return {"final_payload": payload}


def finalize_error_node(state: AgenticState) -> AgenticState:
    """Terminal node for the readiness-rejection branch."""
    readiness = state.get("readiness")
    payload = {
        "error": "Ticket failed validation",
        "code": "ticket_validation_failed",
        "validation": readiness.model_dump(mode="json") if readiness else None,
    }
    if state.get("error"):
        payload["error"] = state["error"]
    return {"final_payload": payload}


# ────────────────────────────────────────────────────────────────────────────
# Graph assembly — built once at import-time, reused per request.
# ────────────────────────────────────────────────────────────────────────────


def _build_graph():
    """Construct the multi-agent state machine.

    Node names are prefixed `agent_` so they never collide with state keys
    (LangGraph treats colliding names as an error).
    """
    g = StateGraph(AgenticState)

    g.add_node("agent_readiness", readiness_agent)
    g.add_node("agent_requirements", requirement_extractor_agent)
    g.add_node("agent_generator", test_generator_agent)
    g.add_node("agent_reviewer", quality_reviewer_agent)
    g.add_node("repair_prep", repair_router_state_update)
    g.add_node("agent_scorer", scorer_agent)
    g.add_node("finalize_ok", finalize_node)
    g.add_node("finalize_error", finalize_error_node)

    g.add_edge(START, "agent_readiness")
    g.add_conditional_edges(
        "agent_readiness",
        route_after_readiness,
        {
            "extract_requirements": "agent_requirements",
            "end_with_error": "finalize_error",
        },
    )
    g.add_edge("agent_requirements", "agent_generator")
    g.add_edge("agent_generator", "agent_reviewer")
    g.add_conditional_edges(
        "agent_reviewer",
        route_after_review,
        {
            "repair": "repair_prep",
            "score": "agent_scorer",
            "end_with_error": "finalize_error",
        },
    )
    g.add_edge("repair_prep", "agent_generator")  # bounded loop
    g.add_edge("agent_scorer", "finalize_ok")
    g.add_edge("finalize_ok", END)
    g.add_edge("finalize_error", END)

    return g.compile()


# Module-level compiled graph — thread-safe for stateless invocation.
AGENTIC_GRAPH = _build_graph()


# ────────────────────────────────────────────────────────────────────────────
# Public entry point — called by main.py
# ────────────────────────────────────────────────────────────────────────────


async def run_agentic_pipeline(
    ticket: JiraTicket,
    platform: Platform,
    *,
    repo_context: RepoContext | None = None,
    provider: str | None = None,
    count_hint: int = 5,
) -> dict[str, Any]:
    """Run the full 5-agent SDLC pipeline. Returns the JSON payload directly.

    The caller (FastAPI route) is responsible for choosing the HTTP status
    code based on the payload's "error" / "code" keys — readiness failures
    map to 422, other errors to 500/502.
    """
    initial: AgenticState = {
        "ticket": ticket,
        "platform": platform,
        "repo_context": repo_context,
        "provider_name": provider,
        "count_hint": count_hint,
        "repair_attempts": 0,
        "repair_feedback": [],
    }
    final = await AGENTIC_GRAPH.ainvoke(initial)
    return final.get("final_payload") or {
        "error": "Pipeline ended without a payload",
        "code": "agentic_pipeline_empty",
    }


# ────────────────────────────────────────────────────────────────────────────
# Streaming variant — yields per-node progress for the UI's progress bar.
#
# LangGraph's `astream(...)` emits one chunk per node completion in the form
# `{node_name: state_updates}`. We translate those into UI-friendly events
# with a stage label, a coarse percentage, and a message. The last event
# (`result`) carries the final payload so the client doesn't need a second
# request.
# ────────────────────────────────────────────────────────────────────────────


_NODE_PROGRESS: dict[str, tuple[int, str, str]] = {
    # node_name → (pct, stage_slug, human_message)
    "agent_readiness":     (12, "readiness",     "Checking ticket readiness"),
    "agent_requirements":  (32, "requirements",  "Extracting requirements"),
    "agent_generator":     (58, "generator",     "Generating test cases"),
    "agent_reviewer":      (72, "reviewer",      "Reviewing quality"),
    "repair_prep":         (66, "repair",        "Preparing repair feedback"),
    "agent_scorer":        (88, "scorer",        "Scoring with cross-family judge"),
    "finalize_ok":         (98, "finalize",      "Finalizing"),
    "finalize_error":      (98, "finalize",      "Finalizing (error path)"),
}


async def run_agentic_pipeline_stream(
    ticket: JiraTicket,
    platform: Platform,
    *,
    repo_context: RepoContext | None = None,
    provider: str | None = None,
    count_hint: int = 5,
):
    """Async generator yielding (event_name, json_payload) tuples.

    Event sequence is roughly:
      progress {stage, pct, message, repair_attempts?}   * N
      result   {<final_payload>}                          (once, at end)

    On terminal failure the result event still fires with an "error" key,
    so the client always gets exactly one terminal event to listen for.
    """
    initial: AgenticState = {
        "ticket": ticket,
        "platform": platform,
        "repo_context": repo_context,
        "provider_name": provider,
        "count_hint": count_hint,
        "repair_attempts": 0,
        "repair_feedback": [],
    }

    yield ("progress", {"stage": "start", "pct": 2, "message": "Initializing pipeline"})

    final_state: dict[str, Any] = {}
    try:
        # astream yields {node_name: state_update_for_that_node}. We merge
        # cumulatively so we have the final state on the last event.
        async for chunk in AGENTIC_GRAPH.astream(initial):
            for node_name, update in chunk.items():
                if isinstance(update, dict):
                    final_state.update(update)
                pct, stage, msg = _NODE_PROGRESS.get(
                    node_name, (50, node_name, f"Running {node_name}"),
                )
                event_payload = {
                    "stage": stage,
                    "node": node_name,
                    "pct": pct,
                    "message": msg,
                }
                # Surface repair info so the UI can say "Repair attempt 1/2".
                if "repair_attempts" in final_state:
                    event_payload["repair_attempts"] = final_state["repair_attempts"]
                yield ("progress", event_payload)
    except Exception as e:  # noqa: BLE001
        yield (
            "result",
            {
                "error": f"Pipeline crashed mid-stream: {e}",
                "code": "agentic_pipeline_failed",
            },
        )
        return

    payload = final_state.get("final_payload") or {
        "error": "Pipeline ended without a payload",
        "code": "agentic_pipeline_empty",
    }
    yield ("progress", {"stage": "done", "pct": 100, "message": "Done"})
    yield ("result", payload)
