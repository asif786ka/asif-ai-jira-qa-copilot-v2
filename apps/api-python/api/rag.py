"""Hybrid RAG layer for the agentic pipelines.

Architecture
────────────

* **Two abstractions, one interface each.** ``EmbeddingProvider`` mirrors the
  shape of the LLM provider registry — a single 2-method ABC any vendor can
  satisfy. ``VectorStore`` is similarly minimal: ``upsert``, ``query_vector``,
  ``query_keyword``, ``delete_repo``.

* **Two concrete stores ship.** ``SqliteVecStore`` for dev/demo — zero infra,
  single file at ``apps/api-python/.rag.db``. ``PgvectorStore`` for prod —
  reuses whatever Postgres holds your application state (Vercel Postgres,
  Neon, Supabase, RDS). One environment variable (``RAG_BACKEND``) flips
  between them; no caller code changes.

* **Hybrid retrieval, RRF merge.** Every query runs vector search + keyword
  search in parallel and merges the two ranked lists via Reciprocal Rank
  Fusion. Beats either alone on code/test corpora — vector handles
  paraphrases, keyword handles exact identifier matches.

* **Faithfulness scoring is built in.** ``faithfulness_score(generated_text,
  retrieved_docs)`` returns the fraction of retrieved chunks whose path / key
  symbols appear in the generated output. Used as an online metric we can
  sample-log via Langfuse / OpenTelemetry; a precursor to a full RAGAS
  faithfulness run for offline eval.

* **Re-ranker hook.** ``rerank()`` is wired in but ships as a no-op
  identity function. Swap in a cross-encoder (e.g.
  ``BAAI/bge-reranker-v2-m3``) without changing call sites.

Schema (sqlite-vec backend)
───────────────────────────

    docs(rowid, repo, path, content, metadata_json, updated_at)
    vec_docs USING vec0(rowid, embedding float[D])     -- vector ANN
    docs_fts USING fts5(content, content='docs', content_rowid='rowid') -- keyword

Schema (Postgres backend)
─────────────────────────

    CREATE EXTENSION IF NOT EXISTS vector;
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
    CREATE TABLE rag_docs (
        id BIGSERIAL PRIMARY KEY,
        repo TEXT NOT NULL,
        path TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata JSONB DEFAULT '{}'::jsonb,
        embedding vector(1536),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (repo, path)
    );
    CREATE INDEX rag_docs_vec_idx ON rag_docs USING hnsw (embedding vector_cosine_ops);
    CREATE INDEX rag_docs_content_trgm ON rag_docs USING gin (content gin_trgm_ops);

The ``PgvectorStore`` below assumes that schema. Implementation uses ``psycopg``
which is loaded lazily so dev installs without Postgres remain light.
"""

from __future__ import annotations

import json
import logging
import os
import re
import sqlite3
import struct
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Optional

import httpx

logger = logging.getLogger("jiraqa.python.rag")


# ────────────────────────────────────────────────────────────────────────────
# Tunables — sized for code/test corpora. Embedding dim must match the model.
# ────────────────────────────────────────────────────────────────────────────

DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small"
DEFAULT_EMBEDDING_DIM = 1536       # text-embedding-3-small native dimension
DEFAULT_TOP_K_VECTOR = 12
DEFAULT_TOP_K_KEYWORD = 12
DEFAULT_TOP_K_FINAL = 8
RRF_K = 60  # Reciprocal Rank Fusion constant — see Cormack et al. 2009


# ────────────────────────────────────────────────────────────────────────────
# Public dataclasses
# ────────────────────────────────────────────────────────────────────────────


@dataclass
class IndexedDoc:
    """A single corpus chunk awaiting indexing."""

    repo: str
    path: str
    content: str
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class RetrievedDoc:
    """A retrieval hit, common shape across vector + keyword + fused."""

    repo: str
    path: str
    content: str
    metadata: dict[str, Any]
    score: float                       # higher = better (fused / RRF)
    source: str = "fused"              # "vector" | "keyword" | "fused"
    distance: Optional[float] = None   # vector-only signal (cosine distance)


# ────────────────────────────────────────────────────────────────────────────
# Embedding providers — same pattern as LLM providers
# ────────────────────────────────────────────────────────────────────────────


class EmbeddingProvider(ABC):
    name: str
    model: str
    dim: int

    @abstractmethod
    async def embed(self, texts: list[str]) -> list[list[float]]: ...


class OpenAIEmbeddingProvider(EmbeddingProvider):
    """``text-embedding-3-small`` by default — 1536 dims, $0.02 / 1M tokens.

    Reads ``OPENAI_API_KEY`` from the environment (already loaded by
    ``api/main.py`` via python-dotenv). Override the model with
    ``OPENAI_EMBEDDING_MODEL``.
    """

    name = "openai"

    def __init__(self, *, api_key: str | None = None, model: str | None = None) -> None:
        self.api_key = api_key or os.environ.get("OPENAI_API_KEY", "")
        self.model = model or os.environ.get("OPENAI_EMBEDDING_MODEL", DEFAULT_EMBEDDING_MODEL)
        # Production models we ship configs for. Anything else: dimension is
        # discovered from the first response.
        self.dim = {
            "text-embedding-3-small": 1536,
            "text-embedding-3-large": 3072,
            "text-embedding-ada-002": 1536,
        }.get(self.model, DEFAULT_EMBEDDING_DIM)

    async def embed(self, texts: list[str]) -> list[list[float]]:
        if not self.api_key:
            raise RuntimeError("OPENAI_API_KEY is not set")
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(
                "https://api.openai.com/v1/embeddings",
                headers={
                    "authorization": f"Bearer {self.api_key}",
                    "content-type": "application/json",
                },
                json={"model": self.model, "input": texts},
            )
            resp.raise_for_status()
            data = resp.json()
        vectors = [d["embedding"] for d in data["data"]]
        if vectors and self.dim != len(vectors[0]):
            self.dim = len(vectors[0])
        return vectors


def resolve_embedding_provider(name: str | None = None) -> EmbeddingProvider:
    """Pick the default embedding provider. Mirrors ``resolve_llm_provider``."""
    chosen = (name or os.environ.get("DEFAULT_EMBEDDING_PROVIDER") or "openai").lower()
    if chosen == "openai":
        return OpenAIEmbeddingProvider()
    raise ValueError(f"Unknown embedding provider: {chosen}")


# ────────────────────────────────────────────────────────────────────────────
# Vector-store abstraction
# ────────────────────────────────────────────────────────────────────────────


class VectorStore(ABC):
    """Minimal store interface — two write methods, two read methods."""

    dim: int

    @abstractmethod
    def upsert(self, docs: list[IndexedDoc], embeddings: list[list[float]]) -> int: ...

    @abstractmethod
    def query_vector(
        self, embedding: list[float], *, repo: str | None = None, k: int = DEFAULT_TOP_K_VECTOR,
    ) -> list[RetrievedDoc]: ...

    @abstractmethod
    def query_keyword(
        self, text: str, *, repo: str | None = None, k: int = DEFAULT_TOP_K_KEYWORD,
    ) -> list[RetrievedDoc]: ...

    @abstractmethod
    def delete_repo(self, repo: str) -> int: ...

    def close(self) -> None:  # noqa: D401
        """Override if your backend keeps a connection open."""


# ────────────────────────────────────────────────────────────────────────────
# SqliteVecStore — dev/demo backend
# ────────────────────────────────────────────────────────────────────────────


def _f32_blob(vec: list[float]) -> bytes:
    """Pack a float vector into the little-endian f32 blob sqlite-vec expects."""
    return struct.pack(f"<{len(vec)}f", *vec)


class SqliteVecStore(VectorStore):
    """Single-file SQLite backend using sqlite-vec for ANN + FTS5 for keyword.

    The DB lives at ``apps/api-python/.rag.db`` by default. No service to
    start, no auth, no migration tool — ideal for `./run-dev.sh` and CI.
    """

    def __init__(self, db_path: str | None = None, dim: int = DEFAULT_EMBEDDING_DIM) -> None:
        self.dim = dim
        self.db_path = db_path or os.environ.get(
            "RAG_SQLITE_PATH",
            str(Path(__file__).resolve().parent.parent / ".rag.db"),
        )
        self._conn = sqlite3.connect(self.db_path)
        self._load_extension()
        self._init_schema()

    def _load_extension(self) -> None:
        try:
            import sqlite_vec  # type: ignore
        except ImportError as e:  # pragma: no cover — install-time
            raise RuntimeError(
                "sqlite-vec is not installed. `pip install sqlite-vec`."
            ) from e
        self._conn.enable_load_extension(True)
        sqlite_vec.load(self._conn)
        self._conn.enable_load_extension(False)

    def _init_schema(self) -> None:
        cur = self._conn.cursor()
        cur.executescript(
            f"""
            CREATE TABLE IF NOT EXISTS docs (
                rowid INTEGER PRIMARY KEY AUTOINCREMENT,
                repo TEXT NOT NULL,
                path TEXT NOT NULL,
                content TEXT NOT NULL,
                metadata_json TEXT NOT NULL DEFAULT '{{}}',
                updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
                UNIQUE (repo, path)
            );
            CREATE INDEX IF NOT EXISTS docs_repo_idx ON docs(repo);
            CREATE VIRTUAL TABLE IF NOT EXISTS vec_docs USING vec0(
                rowid INTEGER PRIMARY KEY,
                embedding float[{self.dim}]
            );
            CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
                content,
                content='docs',
                content_rowid='rowid'
            );
            """
        )
        self._conn.commit()

    # ── Writes ──────────────────────────────────────────────────────────

    def upsert(self, docs: list[IndexedDoc], embeddings: list[list[float]]) -> int:
        if len(docs) != len(embeddings):
            raise ValueError("docs and embeddings must have the same length")
        cur = self._conn.cursor()
        wrote = 0
        for doc, emb in zip(docs, embeddings):
            cur.execute(
                "SELECT rowid FROM docs WHERE repo = ? AND path = ?",
                (doc.repo, doc.path),
            )
            row = cur.fetchone()
            if row:
                rowid = row[0]
                cur.execute(
                    "UPDATE docs SET content = ?, metadata_json = ?, "
                    "updated_at = strftime('%s','now') WHERE rowid = ?",
                    (doc.content, json.dumps(doc.metadata), rowid),
                )
                cur.execute("DELETE FROM vec_docs WHERE rowid = ?", (rowid,))
                cur.execute("DELETE FROM docs_fts WHERE rowid = ?", (rowid,))
            else:
                cur.execute(
                    "INSERT INTO docs (repo, path, content, metadata_json) VALUES (?, ?, ?, ?)",
                    (doc.repo, doc.path, doc.content, json.dumps(doc.metadata)),
                )
                rowid = cur.lastrowid
            cur.execute(
                "INSERT INTO vec_docs (rowid, embedding) VALUES (?, ?)",
                (rowid, _f32_blob(emb)),
            )
            cur.execute(
                "INSERT INTO docs_fts (rowid, content) VALUES (?, ?)",
                (rowid, doc.content),
            )
            wrote += 1
        self._conn.commit()
        return wrote

    def delete_repo(self, repo: str) -> int:
        cur = self._conn.cursor()
        cur.execute("SELECT rowid FROM docs WHERE repo = ?", (repo,))
        rowids = [r[0] for r in cur.fetchall()]
        for rid in rowids:
            cur.execute("DELETE FROM vec_docs WHERE rowid = ?", (rid,))
            cur.execute("DELETE FROM docs_fts WHERE rowid = ?", (rid,))
            cur.execute("DELETE FROM docs WHERE rowid = ?", (rid,))
        self._conn.commit()
        return len(rowids)

    # ── Reads ───────────────────────────────────────────────────────────

    def _materialise(self, rows: Iterable[tuple]) -> list[tuple[int, str, str, str, str]]:
        """Yield (rowid, repo, path, content, metadata_json) tuples in order."""
        return [(r[0], r[1], r[2], r[3], r[4]) for r in rows]

    def query_vector(
        self, embedding: list[float], *, repo: str | None = None, k: int = DEFAULT_TOP_K_VECTOR,
    ) -> list[RetrievedDoc]:
        cur = self._conn.cursor()
        # sqlite-vec needs MATCH-style query against the virtual table.
        cur.execute(
            "SELECT rowid, distance FROM vec_docs "
            "WHERE embedding MATCH ? AND k = ? "
            "ORDER BY distance ASC",
            (_f32_blob(embedding), k),
        )
        hits = cur.fetchall()
        if not hits:
            return []
        rowids = [h[0] for h in hits]
        distances = {h[0]: h[1] for h in hits}
        placeholders = ",".join("?" * len(rowids))
        params: list[Any] = list(rowids)
        repo_clause = ""
        if repo:
            repo_clause = " AND repo = ?"
            params.append(repo)
        cur.execute(
            f"SELECT rowid, repo, path, content, metadata_json FROM docs "
            f"WHERE rowid IN ({placeholders}){repo_clause}",
            params,
        )
        rows = self._materialise(cur.fetchall())
        rows.sort(key=lambda r: distances.get(r[0], float("inf")))
        return [
            RetrievedDoc(
                repo=r[1],
                path=r[2],
                content=r[3],
                metadata=json.loads(r[4] or "{}"),
                score=1.0 / (1.0 + distances[r[0]]),
                source="vector",
                distance=distances[r[0]],
            )
            for r in rows
        ]

    def query_keyword(
        self, text: str, *, repo: str | None = None, k: int = DEFAULT_TOP_K_KEYWORD,
    ) -> list[RetrievedDoc]:
        cleaned = _sanitise_fts(text)
        if not cleaned:
            return []
        cur = self._conn.cursor()
        cur.execute(
            "SELECT docs.rowid, docs.repo, docs.path, docs.content, docs.metadata_json, "
            "bm25(docs_fts) AS rank "
            "FROM docs_fts JOIN docs ON docs.rowid = docs_fts.rowid "
            "WHERE docs_fts MATCH ? "
            + ("AND docs.repo = ? " if repo else "")
            + "ORDER BY rank LIMIT ?",
            (cleaned, repo, k) if repo else (cleaned, k),
        )
        out: list[RetrievedDoc] = []
        for row in cur.fetchall():
            out.append(
                RetrievedDoc(
                    repo=row[1],
                    path=row[2],
                    content=row[3],
                    metadata=json.loads(row[4] or "{}"),
                    # bm25 returns negative rank where lower is better;
                    # invert so higher = better and bound to [0,1].
                    score=1.0 / (1.0 + max(0.0, -float(row[5]))),
                    source="keyword",
                )
            )
        return out

    def close(self) -> None:
        try:
            self._conn.close()
        except Exception:  # noqa: BLE001
            pass


def _sanitise_fts(text: str) -> str:
    """FTS5 MATCH dialect rejects unescaped special chars. Strip them and
    keep word tokens — good enough for code identifiers and ticket prose."""
    tokens = re.findall(r"[A-Za-z][A-Za-z0-9_]{1,}", text)
    return " OR ".join(tokens[:32])  # cap query length


# ────────────────────────────────────────────────────────────────────────────
# PgvectorStore — production backend (lazy-loaded psycopg)
# ────────────────────────────────────────────────────────────────────────────


class PgvectorStore(VectorStore):
    """Postgres + pgvector backend.

    Requires the schema documented at the top of this file and a
    `DATABASE_URL` env var. ``psycopg`` is imported lazily so dev environments
    without Postgres don't have to install it.

    Hybrid keyword search uses ``pg_trgm`` similarity rather than tsvector —
    pg_trgm handles code identifiers better than language-aware tokenizers,
    which split on `_` / `.` boundaries we want to preserve.
    """

    def __init__(self, dsn: str | None = None, dim: int = DEFAULT_EMBEDDING_DIM) -> None:
        self.dim = dim
        self.dsn = dsn or os.environ.get("DATABASE_URL", "")
        if not self.dsn:
            raise RuntimeError("DATABASE_URL must be set for pgvector backend")
        try:
            import psycopg  # type: ignore  # noqa: F401
            from psycopg.types.json import Json  # type: ignore  # noqa: F401
        except ImportError as e:  # pragma: no cover
            raise RuntimeError(
                "psycopg[binary] is not installed. "
                "Add it to requirements.txt when enabling RAG_BACKEND=postgres."
            ) from e
        self._psycopg = __import__("psycopg")

    # NOTE: implementations below are intentionally short — they mirror the
    # sqlite path with stock SQL. Open a connection per call (driver pools
    # the underlying socket); a long-running app would use a pool.

    def _conn(self):  # type: ignore[override]
        return self._psycopg.connect(self.dsn, autocommit=False)

    def upsert(self, docs: list[IndexedDoc], embeddings: list[list[float]]) -> int:
        if len(docs) != len(embeddings):
            raise ValueError("docs and embeddings must have the same length")
        wrote = 0
        with self._conn() as conn:
            with conn.cursor() as cur:
                for doc, emb in zip(docs, embeddings):
                    cur.execute(
                        """
                        INSERT INTO rag_docs (repo, path, content, metadata, embedding)
                        VALUES (%s, %s, %s, %s::jsonb, %s::vector)
                        ON CONFLICT (repo, path) DO UPDATE SET
                          content = EXCLUDED.content,
                          metadata = EXCLUDED.metadata,
                          embedding = EXCLUDED.embedding,
                          updated_at = NOW()
                        """,
                        (doc.repo, doc.path, doc.content, json.dumps(doc.metadata), emb),
                    )
                    wrote += 1
            conn.commit()
        return wrote

    def delete_repo(self, repo: str) -> int:
        with self._conn() as conn:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM rag_docs WHERE repo = %s", (repo,))
                deleted = cur.rowcount or 0
            conn.commit()
        return deleted

    def query_vector(
        self, embedding: list[float], *, repo: str | None = None, k: int = DEFAULT_TOP_K_VECTOR,
    ) -> list[RetrievedDoc]:
        sql = (
            "SELECT repo, path, content, metadata, "
            "1 - (embedding <=> %s::vector) AS sim, "
            "embedding <=> %s::vector AS dist "
            "FROM rag_docs "
        )
        params: list[Any] = [embedding, embedding]
        if repo:
            sql += "WHERE repo = %s "
            params.append(repo)
        sql += "ORDER BY embedding <=> %s::vector LIMIT %s"
        params.extend([embedding, k])
        out: list[RetrievedDoc] = []
        with self._conn() as conn:
            with conn.cursor() as cur:
                cur.execute(sql, params)
                for r in cur.fetchall():
                    out.append(
                        RetrievedDoc(
                            repo=r[0], path=r[1], content=r[2],
                            metadata=r[3] or {},
                            score=float(r[4]), source="vector", distance=float(r[5]),
                        )
                    )
        return out

    def query_keyword(
        self, text: str, *, repo: str | None = None, k: int = DEFAULT_TOP_K_KEYWORD,
    ) -> list[RetrievedDoc]:
        sql = (
            "SELECT repo, path, content, metadata, "
            "similarity(content, %s) AS sim "
            "FROM rag_docs "
            "WHERE content %% %s "
        )
        params: list[Any] = [text, text]
        if repo:
            sql += "AND repo = %s "
            params.append(repo)
        sql += "ORDER BY sim DESC LIMIT %s"
        params.append(k)
        out: list[RetrievedDoc] = []
        with self._conn() as conn:
            with conn.cursor() as cur:
                cur.execute(sql, params)
                for r in cur.fetchall():
                    out.append(
                        RetrievedDoc(
                            repo=r[0], path=r[1], content=r[2],
                            metadata=r[3] or {},
                            score=float(r[4]), source="keyword",
                        )
                    )
        return out


# ────────────────────────────────────────────────────────────────────────────
# Hybrid retrieval — RRF + optional re-ranker
# ────────────────────────────────────────────────────────────────────────────


def _rrf_merge(
    vector_hits: list[RetrievedDoc],
    keyword_hits: list[RetrievedDoc],
    k_final: int = DEFAULT_TOP_K_FINAL,
) -> list[RetrievedDoc]:
    """Reciprocal Rank Fusion — robust against arbitrary score scales.

    score(d) = sum_over_rankings(1 / (RRF_K + rank_in_that_list))
    Constant RRF_K=60 follows the original paper.
    """
    by_id: dict[tuple[str, str], RetrievedDoc] = {}
    fused: dict[tuple[str, str], float] = {}
    for rank, hit in enumerate(vector_hits, start=1):
        key = (hit.repo, hit.path)
        by_id.setdefault(key, hit)
        fused[key] = fused.get(key, 0.0) + 1.0 / (RRF_K + rank)
    for rank, hit in enumerate(keyword_hits, start=1):
        key = (hit.repo, hit.path)
        by_id.setdefault(key, hit)
        fused[key] = fused.get(key, 0.0) + 1.0 / (RRF_K + rank)
    ordered = sorted(fused.items(), key=lambda x: x[1], reverse=True)[:k_final]
    out: list[RetrievedDoc] = []
    for key, score in ordered:
        base = by_id[key]
        out.append(
            RetrievedDoc(
                repo=base.repo, path=base.path, content=base.content,
                metadata=base.metadata, score=score, source="fused",
                distance=base.distance,
            )
        )
    return out


def rerank(
    query: str,           # noqa: ARG001 — kept for the future cross-encoder
    hits: list[RetrievedDoc],
) -> list[RetrievedDoc]:
    """Optional re-ranking step.

    Default implementation is an identity function. Swap in a cross-encoder
    (e.g. ``BAAI/bge-reranker-v2-m3`` via sentence-transformers) when you
    need the extra precision. The call site never changes.
    """
    return hits


async def hybrid_query(
    store: VectorStore,
    embedder: EmbeddingProvider,
    query_text: str,
    *,
    repo: str | None = None,
    k_vector: int = DEFAULT_TOP_K_VECTOR,
    k_keyword: int = DEFAULT_TOP_K_KEYWORD,
    k_final: int = DEFAULT_TOP_K_FINAL,
) -> list[RetrievedDoc]:
    """End-to-end retrieval: embed → vector + keyword in parallel → RRF → rerank."""
    vec = (await embedder.embed([query_text]))[0]
    vector_hits = store.query_vector(vec, repo=repo, k=k_vector)
    keyword_hits = store.query_keyword(query_text, repo=repo, k=k_keyword)
    fused = _rrf_merge(vector_hits, keyword_hits, k_final=k_final)
    return rerank(query_text, fused)


# ────────────────────────────────────────────────────────────────────────────
# Faithfulness — cheap online metric. RAGAS-grade scoring lives offline.
# ────────────────────────────────────────────────────────────────────────────


_IDENTIFIER_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]{2,}")


def faithfulness_score(
    generated_text: str, retrieved_docs: list[RetrievedDoc],
) -> dict[str, Any]:
    """Fraction of retrieved chunks the generator actually grounded on.

    Heuristic: for each retrieved doc, extract the path's last component
    + top-N identifiers from its content; mark the doc "cited" iff the
    generator's output mentions any of those. Returns ``{score, cited,
    total, hit_paths}``.

    This is a coarse online signal. For offline / nightly eval, run a
    proper RAGAS faithfulness pass with an LLM judge — same idea, much
    higher quality.
    """
    if not retrieved_docs:
        return {"score": None, "cited": 0, "total": 0, "hit_paths": []}
    gen_lower = generated_text.lower()
    hit_paths: list[str] = []
    cited = 0
    for d in retrieved_docs:
        leaf = d.path.split("/")[-1].lower()
        identifiers = _IDENTIFIER_RE.findall(d.content)
        # Most-frequent identifiers in the chunk: cheap proxy for "key symbols".
        freq: dict[str, int] = {}
        for tok in identifiers:
            if len(tok) >= 4 and not tok.lower() in {
                "true", "false", "none", "null", "import", "return", "function",
            }:
                freq[tok] = freq.get(tok, 0) + 1
        top = [w for w, _ in sorted(freq.items(), key=lambda x: x[1], reverse=True)[:8]]
        signal = [leaf] + [w.lower() for w in top if len(w) > 3]
        if any(s in gen_lower for s in signal if s):
            cited += 1
            hit_paths.append(d.path)
    return {
        "score": round(cited / len(retrieved_docs), 3),
        "cited": cited,
        "total": len(retrieved_docs),
        "hit_paths": hit_paths,
    }


# ────────────────────────────────────────────────────────────────────────────
# Factory — env-switched
# ────────────────────────────────────────────────────────────────────────────


_STORE_SINGLETON: VectorStore | None = None


def get_store(*, fresh: bool = False) -> VectorStore:
    """Return the configured ``VectorStore``. Singleton per-process."""
    global _STORE_SINGLETON
    if _STORE_SINGLETON is not None and not fresh:
        return _STORE_SINGLETON
    backend = (os.environ.get("RAG_BACKEND") or "sqlite").lower()
    if backend == "sqlite":
        _STORE_SINGLETON = SqliteVecStore()
    elif backend in ("postgres", "pgvector"):
        _STORE_SINGLETON = PgvectorStore()
    else:
        raise ValueError(f"Unknown RAG_BACKEND: {backend}")
    return _STORE_SINGLETON


# ────────────────────────────────────────────────────────────────────────────
# Convenience: index a batch of files for a repo
# ────────────────────────────────────────────────────────────────────────────


async def index_repo_files(
    repo: str,
    files: list[dict[str, Any]],
    *,
    store: VectorStore | None = None,
    embedder: EmbeddingProvider | None = None,
) -> int:
    """Index a list of ``{path, content, metadata?}`` dicts under one repo key.

    Used by the ``POST /pyapi/rag/index`` route and by tests.
    """
    if not files:
        return 0
    store = store or get_store()
    embedder = embedder or resolve_embedding_provider()
    docs = [
        IndexedDoc(
            repo=repo,
            path=str(f["path"]),
            content=str(f.get("content", "")),
            metadata=dict(f.get("metadata") or {}),
        )
        for f in files
        if f.get("path") and (f.get("content") or "").strip()
    ]
    if not docs:
        return 0
    # Embed in one batch — OpenAI accepts arrays.
    embeddings = await embedder.embed([d.content[:8000] for d in docs])
    return store.upsert(docs, embeddings)
