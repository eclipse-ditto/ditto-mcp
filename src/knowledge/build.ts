/*
 * Copyright (c) 2026 Contributors to the Eclipse Foundation
 *
 * See the NOTICE file(s) distributed with this work for additional
 * information regarding copyright ownership.
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0
 *
 * SPDX-License-Identifier: EPL-2.0
 */

import { existsSync } from "node:fs";
import type { AppConfig } from "../config/schema.js";
import type { Retriever } from "./types.js";
import type { EmbeddingProvider } from "./embedding.js";
import type { KnowledgeStore, IndexMeta } from "./knowledge-store.js";
import { SCHEMA_VERSION } from "./knowledge-store.js";
import { openStore } from "./store-factory.js";
import { KnowledgeService } from "./knowledge-service.js";
import { FtsRetriever } from "./fts-retriever.js";
import { VectorRetriever } from "./vector-retriever.js";
import { HybridRetriever } from "./hybrid-retriever.js";
import { buildIndex, metaFor } from "./build-index.js";
import { makeSources, makeEmbedder, type FactoryDeps } from "./factories.js";

export type KnowledgeDeps = FactoryDeps;

function metaMatches(meta: IndexMeta | null | undefined, config: AppConfig): boolean {
  if (!meta || meta.complete !== true || meta.schemaVersion !== SCHEMA_VERSION) return false;
  if (meta.retriever !== config.knowledge.retriever) return false;
  if (config.knowledge.retriever === "fts") return true;
  const e = config.knowledge.embedding;
  return meta.embeddingModel === e.model && meta.embeddingDim === e.dim;
}

function describeMeta(meta: Pick<IndexMeta, "retriever" | "embeddingModel" | "embeddingDim">): string {
  return `retriever=${meta.retriever}` +
    (meta.retriever === "fts" ? "" : `, model=${meta.embeddingModel}, dim=${meta.embeddingDim}`);
}

/**
 * An ingest swaps a new pgvector index in while the server runs, and every query reads the
 * swapped tables. So before each search, compare the stored meta with the last one seen, and
 * when it changed, check it against the config again, as at startup. While it doesn't match
 * (embedded with another model or dim, or built for another retriever), searches are refused
 * with the reason. A matching index always has the vector table its retriever needs.
 */
function watchIndex(store: KnowledgeStore, config: AppConfig, meta: IndexMeta | undefined): () => Promise<void> {
  let seen = JSON.stringify(meta ?? null);
  let mismatch: string | undefined;
  const e = config.knowledge.embedding;
  const expected = describeMeta({ retriever: config.knowledge.retriever, embeddingModel: e.model, embeddingDim: e.dim });
  return async () => {
    const current = await store.getMeta();
    const key = JSON.stringify(current ?? null);
    if (key !== seen) {
      seen = key;
      const was = mismatch;
      mismatch = metaMatches(current, config)
        ? undefined
        : `the knowledge index was re-ingested with ${current ? describeMeta(current) : "no metadata"}, ` +
          `but this server is configured for ${expected}; re-ingest with the server's config or restart it with the index's`;
      if (mismatch) process.stderr.write(`[ditto-mcp] knowledge search disabled: ${mismatch}\n`);
      else if (was) process.stderr.write("[ditto-mcp] knowledge search enabled: the re-ingested index matches the config\n");
    }
    if (mismatch) throw new Error(mismatch);
  };
}

export async function buildKnowledgeService(
  config: AppConfig,
  deps: KnowledgeDeps = {},
): Promise<KnowledgeService | undefined> {
  if (!config.knowledge.enabled) return undefined;

  const needsVectors = config.knowledge.retriever !== "fts";
  const embedder: EmbeddingProvider | undefined = needsVectors
    ? await makeEmbedder(config, deps)
    : undefined;

  try {
    // Non-sqlite stores (e.g. pgvector): open, check if populated + meta matches, serve; ELSE warn (no auto-build).
    if (config.knowledge.store.kind !== "sqlite") {
      const store = await openStore(config);
      try {
        if (await store.isPopulated()) {
          const meta = await store.getMeta();
          if (metaMatches(meta, config)) {
            return new KnowledgeService(store, makeRetriever(config, store, embedder), watchIndex(store, config, meta));
          }
        }
        // No matching prebuilt index → warn and disable knowledge (do NOT auto-build for pgvector).
        process.stderr.write(
          `[ditto-mcp] no matching prebuilt index in the configured Postgres store; ` +
          `run \`ingest\` to build it — the server does not build pgvector indexes\n`,
        );
        await store.close();
        return undefined;
      } catch (err) {
        await store.close();
        process.stderr.write(`[ditto-mcp] knowledge init failed: ${String(err)}\n`);
        return undefined;
      }
    }

    // Sqlite: prebuilt file path.
    const path = config.knowledge.store.sqlite.path;
    // Prebuilt file: open and serve without rebuilding.
    if (path && existsSync(path)) {
      try {
        const store = await openStore(config, { path });
        if (await store.isPopulated()) {
          const meta = await store.getMeta();
          if (metaMatches(meta, config)) return new KnowledgeService(store, makeRetriever(config, store, embedder));
          process.stderr.write(
            `[ditto-mcp] prebuilt index at ${path} is incomplete or does not match config ` +
              `(retriever/model/dim/version); rebuilding in memory\n`,
          );
          await store.close();
        } else {
          await store.close();
        }
      } catch (err) {
        process.stderr.write(`[ditto-mcp] cannot open prebuilt index at ${path}: ${String(err)}; rebuilding in memory\n`);
      }
    }

    // Fallback: build in-memory (never writes the configured file).
    if (path) {
      process.stderr.write(
        `[ditto-mcp] no prebuilt index at ${path}; building in memory (run \`ingest\` to persist)\n`,
      );
    }
    const sources = makeSources(config, deps);
    if (sources.length === 0) return undefined;
    const store: KnowledgeStore = await openStore(config, { path: ":memory:" });
    try {
      const report = await buildIndex(sources, store, embedder, metaFor(config, embedder), {
        allowSkipped: true,
        allowFailedSources: true,
      });
      for (const s of report.skipped) {
        process.stderr.write(`[ditto-mcp] knowledge: skipped ${s.source}: ${s.item}: ${s.reason}\n`);
      }
      if (report.skipped.length > 0) {
        process.stderr.write(
          `[ditto-mcp] knowledge: built the in-memory index without ${report.skipped.length} item(s) that failed to load\n`,
        );
      }
    } catch (err) {
      await store.close();
      throw err;
    }
    return new KnowledgeService(store, makeRetriever(config, store, embedder));
  } catch (err) {
    process.stderr.write(
      `[ditto-mcp] knowledge init failed, disabling knowledge tools: ${String(err)}\n`,
    );
    return undefined;
  }
}

function makeRetriever(config: AppConfig, store: KnowledgeStore, embedder?: EmbeddingProvider): Retriever {
  const kind = config.knowledge.retriever;
  if (kind === "fts") return new FtsRetriever(store);
  if (!embedder) throw new Error("vector/hybrid retriever requires an embedder");
  const vector = new VectorRetriever(store, embedder);
  if (kind === "vector") return vector;
  return new HybridRetriever([new FtsRetriever(store), vector]);
}
