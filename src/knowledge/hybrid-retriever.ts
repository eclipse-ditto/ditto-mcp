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

import type { Ranker, RankedId, Retriever, RetrievedChunk } from "./types.js";
import { loadRanked, type KnowledgeStore } from "./knowledge-store.js";

const RRF_K = 60;

export class HybridRetriever implements Retriever {
  readonly kind = "hybrid";

  constructor(
    private readonly store: Pick<KnowledgeStore, "getChunks">,
    private readonly retrievers: Ranker[],
  ) {}

  async rank(query: string, k: number): Promise<RankedId[]> {
    // Fuse deeper lists than we return: a chunk both legs rank just below k outscores any
    // single-leg first place, but only if it was fetched. 2k stays within pgvector's default
    // hnsw.ef_search (40) for the maximum k of 20; an HNSW scan returns at most ef_search rows.
    const depth = Math.max(2 * k, 20);
    const lists = await Promise.all(
      this.retrievers.map((r) => r.rank(query, depth)),
    );
    const scores = new Map<string, number>();
    const matchedBy = new Map<string, Set<string>>();
    for (const list of lists) {
      list.forEach((hit, rank) => {
        scores.set(hit.id, (scores.get(hit.id) ?? 0) + 1 / (RRF_K + rank + 1));
        if (!matchedBy.has(hit.id)) {
          matchedBy.set(hit.id, new Set());
        }
        for (const kind of hit.matchedBy) {
          matchedBy.get(hit.id)!.add(kind);
        }
      });
    }
    return [...scores.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, k)
      .map(([id]) => ({ id, matchedBy: Array.from(matchedBy.get(id)!).sort() }));
  }

  /** Loads only the fused top k: the legs' other candidates are never read. */
  async search(query: string, k: number): Promise<RetrievedChunk[]> {
    return loadRanked(this.store, await this.rank(query, k));
  }
}
