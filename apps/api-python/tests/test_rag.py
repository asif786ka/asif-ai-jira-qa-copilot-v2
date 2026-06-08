"""Tests for the RAG layer.

We mock the embedding provider so the suite runs offline. Three paths:

  1. Index → vector retrieve → keyword retrieve → hybrid RRF.
  2. delete_repo + repo-scoped queries.
  3. faithfulness_score on a real-ish (path leaf + identifiers) pair.
"""

from __future__ import annotations

import os
import tempfile

import pytest

from api import rag


class _StubEmbedder(rag.EmbeddingProvider):
    """Deterministic, content-aware stub. Different content → different vectors.

    Hashes the input into a fixed-dim vector. Good enough that two distinct
    strings end up far apart in cosine space; identical strings produce
    identical vectors.
    """

    name = "stub"
    model = "stub-emb-1"
    dim = 32  # small for test speed

    async def embed(self, texts):
        import hashlib
        out = []
        for t in texts:
            digest = hashlib.sha256(t.encode("utf-8")).digest()
            # 32 bytes → 32 floats in [-1, 1].
            vec = [(b - 128) / 128.0 for b in digest[: self.dim]]
            out.append(vec)
        return out


@pytest.fixture
def store():
    """Fresh sqlite-vec store in a temp file per test."""
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    s = rag.SqliteVecStore(db_path=path, dim=_StubEmbedder.dim)
    yield s
    s.close()
    try:
        os.unlink(path)
    except OSError:
        pass


@pytest.mark.asyncio
async def test_index_and_hybrid_query(store):
    embedder = _StubEmbedder()
    docs = [
        rag.IndexedDoc(repo="acme/web", path="tests/login.spec.ts",
                       content="login submit empty password inline error"),
        rag.IndexedDoc(repo="acme/web", path="tests/upload.spec.ts",
                       content="upload photo crop validate size limit"),
        rag.IndexedDoc(repo="acme/web", path="tests/checkout.spec.ts",
                       content="checkout promo code apply price"),
    ]
    embeddings = await embedder.embed([d.content for d in docs])
    n = store.upsert(docs, embeddings)
    assert n == 3

    # Query by a string that is identical to one of the docs — vector ANN
    # should return it as the top hit because identical text → identical vec.
    target = docs[0].content
    vec = (await embedder.embed([target]))[0]
    v_hits = store.query_vector(vec, k=3)
    assert v_hits, "vector store returned no hits"
    assert v_hits[0].path == "tests/login.spec.ts"

    # Keyword hit on a distinctive token.
    k_hits = store.query_keyword("upload", k=3)
    assert k_hits, "keyword store returned no hits"
    assert any(h.path == "tests/upload.spec.ts" for h in k_hits)

    # End-to-end hybrid query merges both via RRF.
    fused = await rag.hybrid_query(
        store, embedder, target, repo="acme/web", k_final=2,
    )
    assert fused and fused[0].path == "tests/login.spec.ts"
    assert all(h.source == "fused" for h in fused)


@pytest.mark.asyncio
async def test_delete_repo_isolates(store):
    embedder = _StubEmbedder()
    docs_a = [rag.IndexedDoc(repo="org/a", path="a.yaml", content="alpha bravo")]
    docs_b = [rag.IndexedDoc(repo="org/b", path="b.yaml", content="alpha bravo")]
    await _ingest(store, embedder, docs_a + docs_b)

    # Repo filter on keyword search.
    hits = store.query_keyword("alpha", repo="org/a", k=10)
    assert {h.repo for h in hits} == {"org/a"}

    # Delete one repo cleanly.
    removed = store.delete_repo("org/a")
    assert removed == 1
    hits = store.query_keyword("alpha", k=10)
    assert {h.repo for h in hits} == {"org/b"}


@pytest.mark.asyncio
async def test_faithfulness_scoring():
    # Two retrieved chunks; generated text quotes one of them by path leaf.
    retrieved = [
        rag.RetrievedDoc(
            repo="r", path="tests/auth/empty_password.yaml",
            content="appId launchApp tapOn signIn assertVisible passwordRequired",
            metadata={}, score=0.9, source="fused",
        ),
        rag.RetrievedDoc(
            repo="r", path="tests/upload/file_size.yaml",
            content="upload large image toast fileTooLarge maxFiveMb",
            metadata={}, score=0.7, source="fused",
        ),
    ]
    gen = (
        "Generated Maestro flow for empty_password.yaml — taps Sign In "
        "with no password and asserts the inline passwordRequired error."
    )
    out = rag.faithfulness_score(gen, retrieved)
    assert out["total"] == 2
    assert out["cited"] >= 1
    assert "tests/auth/empty_password.yaml" in out["hit_paths"]


async def _ingest(store, embedder, docs):
    embs = await embedder.embed([d.content for d in docs])
    store.upsert(docs, embs)
