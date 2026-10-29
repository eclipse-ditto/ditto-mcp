---
paths:
  - "src/knowledge/**"
  - "src/tools/knowledge.ts"
  - "src/bin/ingest.ts"
---

# Knowledge: search and get_chunk

## Abstractions (`types.ts`, `knowledge-store.ts`)
- A `KnowledgeSource` yields `Chunk[]` through `loadChunks(signal, onSkip)` and never searches. It reports a recoverable per-item failure with `onSkip(item, reason)`, and throws when the whole source fails.
- A `KnowledgeStore` is backend-agnostic: it holds chunks, an FTS index, optional vectors, and `IndexMeta`. There are two implementations, `SqliteKnowledgeStore` and `PgKnowledgeStore`. A new method needs both implementations, with tests in both suites.
- `Retriever.search(query, k)` returns `RetrievedChunk[]`, with `matchedBy` naming the leaf retrievers that matched. The retrievers are `FtsRetriever`, `VectorRetriever`, and `HybridRetriever` (RRF with k=60, ties broken by id).
- `KnowledgeService` combines a retriever, the store, and an optional `beforeSearch` guard, and adds neighbor expansion.
- `tools/knowledge.ts` formats the output. The `search` tool's `limit` (max 20) and `context` (max 5) arguments default to the values in `knowledge.search`.

## Chunk ids
The format is `${source}:${docKey(cite)}#${ordinal}`: `docKey` is the first 12 hex chars of sha256(cite), and the ordinal counts within one document (`chunker.ts`). Ids are deterministic: the same input gives the same ids on every run. Two things depend on that: `get_chunk` working across re-ingests, and neighbor expansion. `parseId` in `knowledge-service.ts` finds neighbors at `#ord±j` and stops when the `cite` changes. Don't change the format without bumping `SCHEMA_VERSION` and updating both places.

Sources keep their order deterministic. `PublicSource` keeps llms.txt order (fetching 8 at a time, placing results by index) and drops repeated URLs, keeping the first. `LocalDirSource` sorts the files it walks and drops repeated files.

## Index metadata
`IndexMeta` is `{ schemaVersion, retriever, embeddingModel?, embeddingDim?, complete }`. `metaMatches` in `build.ts` accepts an index only if it is complete, has the current `SCHEMA_VERSION` and the configured retriever, and, for vector or hybrid, the configured model and dim. Bump `SCHEMA_VERSION` (`knowledge-store.ts`) whenever the stored layout or the id format changes; an old index is then rebuilt or refused instead of serving wrong data.

## Server startup (`buildKnowledgeService` in `build.ts`)
This never fails startup. On any error it logs and returns `undefined`, and the knowledge tools are not registered.
- `pgvector`: opens the store read-only (no DDL). If it is populated and its meta matches, serve it with `watchIndex`; otherwise warn "run ingest" and disable knowledge. The server never builds a pgvector index.
- `sqlite`, when `sqlite.path` exists: if it is populated and matches, serve it. Otherwise fall through to the next step.
- Fallback: build in `":memory:"`, leniently (`allowSkipped` and `allowFailedSources`). The configured file is never written.
- `watchIndex` (pgvector only): before every search, compare `_meta` with what was last seen. If a live swap brought in an index that doesn't match, searches are refused with the reason, and the change is logged. A matching re-ingest enables search again without a restart.

## Ingest (`bin/ingest.ts`, then `buildIndex`, then `withIngestStore`)
- `buildIndex` validates everything before it writes anything:
  - Duplicate source ids, zero chunks, or duplicate chunk ids: always an `IngestError`.
  - Skipped items: an `IngestError` unless `allowSkipped` (the `--force` flag).
  - A source that fails entirely: an `IngestError` unless `allowFailedSources` (only the server's in-memory fallback sets it).

  Only then does it write the chunks, then the vectors (if there is an embedder), and the meta last, with `complete: true`.
- Ingest is strict by default; `--force` tolerates skipped items only. It never writes a partial or empty index.
- Malformed and non-markdown links in llms.txt are filtered out with a warning. They don't count as skipped items, since re-running can't fix them.
- SQLite: the index is built in `${path}.<random>.tmp` and moved over the target with `renameSync` on success; the temp file is deleted on failure. With concurrent ingests, the last to finish wins.
- pgvector, in order:
  1. Take a session-level advisory lock, `pg_try_advisory_lock(hashtext('ditto-mcp-ingest:<lowercased table>'))`, on a dedicated `pg.Client` with keepalive. A second concurrent ingest fails fast.
  2. Open the staging store (`${table}_staging_*`). It is the only place that runs DDL.
  3. `reset`, then build.
  4. `buildVectorIndex`: the HNSW index, built outside any transaction.
  5. `lock.assertHeld()`.
  6. `swapIntoLive`, in one transaction: copy grants from the live tables, drop them, and rename the staging tables, indexes, and primary keys into place.

  On failure, the staging tables are dropped only if the lock is still held.

## Postgres (`pg-knowledge-store.ts`)
- Tables:
  - `${p}_chunks`: a generated `tsv` column (english), with GIN index `${p}_chunks_tsv`.
  - `${p}_meta`: one JSONB row, id=1.
  - `${p}_vec`: `vector(dim)`, with HNSW cosine index `${p}_vec_idx`.

  A new table, index, or constraint must also be renamed in `swapIntoLive` and get its grants copied.
- A serving role needs only USAGE on the schema and SELECT on the three tables. So `connect` without `staging` must never run DDL; it only checks that the tables exist.
- The `pool.on("error")` listener and the lock client's `error`/`end` listeners are mandatory: an unhandled pg error event crashes the process.
- Inserts are batched: `unnest` arrays, 500 rows per statement, all in one transaction. `lastById` drops repeated ids first, because `ON CONFLICT` can't touch the same row twice in one statement.
- Ingest needs a session-level connection; PgBouncer transaction pooling breaks the advisory lock.

## SQLite (`sqlite-knowledge-store.ts`)
The tables are `chunks`, `chunks_fts` (FTS5), `index_meta` (one JSON row, id=1), and `vec_items` (sqlite-vec `vec0`, created lazily by `ensureVectorTable`). FTS queries pass through `ftsTokens`, which quotes each token and ORs them together. Never pass raw user text to `MATCH`. Ties in the ordering are broken by id, to keep results deterministic.

## Embeddings (`embedding.ts`)
`LocalEmbeddings` runs Transformers.js on ONNX. The default model is `Xenova/bge-small-en-v1.5` (dim 384), with mean pooling and normalization, embedding in batches of `batchSize`. It loads lazily, and `retriever: "fts"` must keep working without `@huggingface/transformers` installed. bge reads at most 512 tokens, so keep `chunk.maxChars` under about 1500 for vector and hybrid search.
