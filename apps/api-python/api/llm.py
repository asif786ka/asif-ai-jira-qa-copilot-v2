"""Python mirror of packages/providers/src/llm — same swappable pattern.

Add a new vendor by subclassing LLMProvider and calling register_llm_provider(...).
"""

from __future__ import annotations

import os
import re
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Callable, Optional

import httpx


@dataclass
class LLMCompletionRequest:
    system_prompt: str
    user_prompt: str
    temperature: float = 0.3
    json_mode: bool = False
    max_tokens: Optional[int] = None


@dataclass
class LLMCompletionResponse:
    text: str
    model: str
    provider: str
    usage: Optional[dict] = None


def strip_fences(raw: str) -> str:
    out = re.sub(r"^```(?:json)?\s*", "", raw, flags=re.IGNORECASE)
    out = re.sub(r"\s*```\s*$", "", out, flags=re.IGNORECASE)
    return out.strip()


class LLMProvider(ABC):
    name: str
    default_model: str

    @abstractmethod
    def is_available(self) -> bool: ...

    @abstractmethod
    async def complete(self, req: LLMCompletionRequest) -> LLMCompletionResponse: ...


# ────────────────────────────────────────────────────────────────────────────
# OpenAI
# ────────────────────────────────────────────────────────────────────────────


class OpenAIProvider(LLMProvider):
    name = "openai"

    def __init__(self, api_key: str | None = None, model: str | None = None):
        self.api_key = api_key or os.environ.get("OPENAI_API_KEY")
        self.default_model = model or os.environ.get("OPENAI_MODEL", "gpt-4o-mini")

    def is_available(self) -> bool:
        return bool(self.api_key)

    async def complete(self, req: LLMCompletionRequest) -> LLMCompletionResponse:
        if not self.api_key:
            raise RuntimeError("OPENAI_API_KEY is not set.")
        body: dict = {
            "model": self.default_model,
            "temperature": req.temperature,
            "messages": [
                {"role": "system", "content": req.system_prompt},
                {"role": "user", "content": req.user_prompt},
            ],
        }
        if req.json_mode:
            body["response_format"] = {"type": "json_object"}
        if req.max_tokens:
            body["max_tokens"] = req.max_tokens

        async with httpx.AsyncClient(timeout=60.0) as client:
            res = await client.post(
                "https://api.openai.com/v1/chat/completions",
                headers={
                    "content-type": "application/json",
                    "authorization": f"Bearer {self.api_key}",
                },
                json=body,
            )
            if res.status_code >= 400:
                raise RuntimeError(f"OpenAI {res.status_code}: {res.text[:400]}")
            data = res.json()
        raw = (data.get("choices") or [{}])[0].get("message", {}).get("content", "")
        return LLMCompletionResponse(
            text=strip_fences(raw),
            model=self.default_model,
            provider=self.name,
            usage=data.get("usage"),
        )


# ────────────────────────────────────────────────────────────────────────────
# Gemini
# ────────────────────────────────────────────────────────────────────────────


class GeminiProvider(LLMProvider):
    name = "gemini"

    def __init__(self, api_key: str | None = None, model: str | None = None):
        self.api_key = api_key or os.environ.get("GEMINI_API_KEY")
        self.default_model = model or os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")

    def is_available(self) -> bool:
        return bool(self.api_key)

    async def complete(self, req: LLMCompletionRequest) -> LLMCompletionResponse:
        if not self.api_key:
            raise RuntimeError("GEMINI_API_KEY is not set.")
        body: dict = {
            "systemInstruction": {"parts": [{"text": req.system_prompt}]},
            "contents": [{"role": "user", "parts": [{"text": req.user_prompt}]}],
            "generationConfig": {
                "temperature": req.temperature,
                **({"responseMimeType": "application/json"} if req.json_mode else {}),
                **({"maxOutputTokens": req.max_tokens} if req.max_tokens else {}),
            },
        }
        url = (
            "https://generativelanguage.googleapis.com/v1beta/models/"
            f"{self.default_model}:generateContent?key={self.api_key}"
        )
        async with httpx.AsyncClient(timeout=60.0) as client:
            res = await client.post(url, json=body)
            if res.status_code >= 400:
                raise RuntimeError(f"Gemini {res.status_code}: {res.text[:400]}")
            data = res.json()
        parts = (
            (data.get("candidates") or [{}])[0].get("content", {}).get("parts", [])
        )
        raw = "".join(p.get("text", "") for p in parts)
        usage = data.get("usageMetadata")
        return LLMCompletionResponse(
            text=strip_fences(raw),
            model=self.default_model,
            provider=self.name,
            usage={
                "prompt_tokens": usage.get("promptTokenCount") if usage else None,
                "completion_tokens": usage.get("candidatesTokenCount") if usage else None,
                "total_tokens": usage.get("totalTokenCount") if usage else None,
            }
            if usage
            else None,
        )


# ────────────────────────────────────────────────────────────────────────────
# Registry
# ────────────────────────────────────────────────────────────────────────────

_registry: dict[str, Callable[[], LLMProvider]] = {}


def register_llm_provider(name: str, factory: Callable[[], LLMProvider]) -> None:
    _registry[name] = factory


def list_llm_providers() -> list[str]:
    return list(_registry.keys())


def get_llm_provider(name: str) -> LLMProvider:
    if name not in _registry:
        raise RuntimeError(
            f"Unknown LLM provider '{name}'. Registered: {', '.join(_registry) or '(none)'}"
        )
    return _registry[name]()


def resolve_llm_provider(explicit: str | None = None) -> LLMProvider:
    preferred = explicit or os.environ.get("DEFAULT_LLM_PROVIDER", "openai")
    if preferred in _registry:
        p = get_llm_provider(preferred)
        if p.is_available():
            return p
    for name in _registry:
        p = get_llm_provider(name)
        if p.is_available():
            return p
    raise RuntimeError(
        "No LLM provider is available. Set OPENAI_API_KEY or GEMINI_API_KEY."
    )


register_llm_provider("openai", lambda: OpenAIProvider())
register_llm_provider("gemini", lambda: GeminiProvider())
