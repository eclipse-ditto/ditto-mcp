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

export interface Chunk {
  id: string;
  source: string;
  title: string;
  text: string;
  cite: string;
}

export interface RetrievedChunk {
  chunk: Chunk;
  matchedBy: string[]; // leaf retriever kinds, e.g. ["fts"], ["vector"], ["fts","vector"]
  // "anchor" = matched by the retriever; "context" = a positional neighbor pulled
  // in by expansion. Absent means anchor (pre-expansion results).
  role?: "anchor" | "context";
}

export type SkipFn = (item: string, reason: string) => void;

export interface SkippedItem {
  source: string;
  item: string;
  reason: string;
}

/** A corpus provider: yields chunks. Does not search. */
export interface KnowledgeSource {
  id: string;
  loadChunks(signal?: AbortSignal, onSkip?: SkipFn): Promise<Chunk[]>;
}

/** A match before its chunk is loaded. */
export interface RankedId {
  id: string;
  matchedBy: string[];
}

/** Ranks chunk ids for a query, best first, without loading the chunks. */
export interface Ranker {
  rank(query: string, k: number): Promise<RankedId[]>;
}

/** Searches the indexed chunks. `rank` lets a caller fuse results before loading any chunk. */
export interface Retriever extends Ranker {
  readonly kind: string;
  search(query: string, k: number): Promise<RetrievedChunk[]>;
}
