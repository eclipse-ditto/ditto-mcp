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

import type { Chunk, Retriever, RetrievedChunk } from "./types.js";

const RRF_K = 60;

export class HybridRetriever implements Retriever {
  readonly kind = "hybrid";

  constructor(private readonly retrievers: Retriever[]) {}

  async search(query: string, k: number): Promise<RetrievedChunk[]> {
    // Fuse deeper lists than we return: a chunk both legs rank just below k outscores any
    // single-leg first place, but only if it was fetched. 2k stays within pgvector's default
    // hnsw.ef_search (40) for the maximum k of 20; an HNSW scan returns at most ef_search rows.
    const depth = Math.max(2 * k, 20);
    const lists = await Promise.all(
      this.retrievers.map((r) => r.search(query, depth)),
    );
    const scores = new Map<string, number>();
    const byId = new Map<string, Chunk>();
    const matchedBy = new Map<string, Set<string>>();
    for (const list of lists) {
      list.forEach((rc, rank) => {
        byId.set(rc.chunk.id, rc.chunk);
        scores.set(rc.chunk.id, (scores.get(rc.chunk.id) ?? 0) + 1 / (RRF_K + rank + 1));
        if (!matchedBy.has(rc.chunk.id)) {
          matchedBy.set(rc.chunk.id, new Set());
        }
        for (const kind of rc.matchedBy) {
          matchedBy.get(rc.chunk.id)!.add(kind);
        }
      });
    }
    return [...scores.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, k)
      .map(([id]) => ({
        chunk: byId.get(id)!,
        matchedBy: Array.from(matchedBy.get(id)!).sort(),
      }));
  }
}
