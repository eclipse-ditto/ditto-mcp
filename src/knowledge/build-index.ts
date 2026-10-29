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

import type { KnowledgeSource, SkippedItem, Chunk } from "./types.js";
import type { KnowledgeStore } from "./knowledge-store.js";
import type { EmbeddingProvider } from "./embedding.js";
import { SCHEMA_VERSION } from "./knowledge-store.js";
import type { AppConfig } from "../config/schema.js";
import { IngestError, errorReason } from "./ingest-error.js";

export interface BuildOptions {
  allowSkipped?: boolean;
  allowFailedSources?: boolean;
  signal?: AbortSignal;
}

export interface BuildReport {
  chunks: number;
  skipped: SkippedItem[];
}

export function metaFor(
  config: AppConfig,
  embedder?: EmbeddingProvider,
): { retriever: string; embeddingModel?: string; embeddingDim?: number } {
  return {
    retriever: config.knowledge.retriever,
    embeddingModel: embedder ? config.knowledge.embedding.model : undefined,
    embeddingDim: embedder ? config.knowledge.embedding.dim : undefined,
  };
}

export async function buildIndex(
  sources: KnowledgeSource[],
  store: KnowledgeStore,
  embedder?: EmbeddingProvider,
  meta?: { retriever: string; embeddingModel?: string; embeddingDim?: number },
  opts: BuildOptions = {},
): Promise<BuildReport> {
  const skipped: SkippedItem[] = [];
  const allChunks: Chunk[] = [];

  // Step 1: Check for duplicate source ids
  const ids = new Set<string>();
  for (const source of sources) {
    if (ids.has(source.id)) {
      throw new IngestError(`two knowledge sources share the id "${source.id}"`);
    }
    ids.add(source.id);
  }

  // Step 2: Load chunks from each source
  for (const source of sources) {
    try {
      const chunks = await source.loadChunks(opts.signal, (item, reason) => {
        skipped.push({ source: source.id, item, reason });
      });
      allChunks.push(...chunks);
    } catch (err) {
      const reason = errorReason(err);
      if (opts.allowFailedSources) {
        skipped.push({ source: source.id, item: "(source)", reason });
      } else {
        throw new IngestError(`${source.id}: ${reason}`, { cause: err });
      }
    }
  }

  // Step 3: Validate chunks
  const formatSkipped = (items: SkippedItem[]) =>
    items.map((s) => `  ${s.source}: ${s.item}: ${s.reason}`).join("\n");

  if (allChunks.length === 0) {
    const msg =
      skipped.length > 0
        ? `no chunks loaded from any source; refusing to write an empty index\n${formatSkipped(skipped)}`
        : "no chunks loaded from any source; refusing to write an empty index";
    throw new IngestError(msg);
  }

  // Check for duplicate chunk ids
  const chunkIds = new Map<string, string>();
  for (const chunk of allChunks) {
    const existing = chunkIds.get(chunk.id);
    if (existing) {
      throw new IngestError(`duplicate chunk id "${chunk.id}" (${existing} and ${chunk.cite})`);
    }
    chunkIds.set(chunk.id, chunk.cite);
  }

  // Check if we should fail on skipped items
  if (skipped.length > 0 && !opts.allowSkipped) {
    throw new IngestError(`${skipped.length} item(s) failed to load:\n${formatSkipped(skipped)}`, {
      skipped,
    });
  }

  // Step 4: Write to store
  if (embedder) await store.ensureVectorTable(embedder.dim);
  await store.addChunks(allChunks);
  if (embedder && allChunks.length > 0) {
    const vectors = await embedder.embed(allChunks.map((c) => c.text), opts.signal);
    await store.upsertVectors(allChunks.map((c, i) => ({ id: c.id, vector: vectors[i] })));
  }
  await store.setMeta({
    schemaVersion: SCHEMA_VERSION,
    retriever: meta?.retriever ?? "fts",
    embeddingModel: meta?.embeddingModel,
    embeddingDim: meta?.embeddingDim,
    complete: true,
  });

  return { chunks: allChunks.length, skipped };
}
