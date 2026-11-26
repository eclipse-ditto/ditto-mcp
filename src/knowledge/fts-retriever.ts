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

import type { RankedId, RetrievedChunk, Retriever } from "./types.js";
import { loadRanked, type KnowledgeStore } from "./knowledge-store.js";

export class FtsRetriever implements Retriever {
  readonly kind = "fts";
  constructor(private readonly store: KnowledgeStore) {}

  async rank(query: string, k: number): Promise<RankedId[]> {
    return (await this.store.ftsSearch(query, k)).map((id) => ({ id, matchedBy: ["fts"] }));
  }

  async search(query: string, k: number): Promise<RetrievedChunk[]> {
    return loadRanked(this.store, await this.rank(query, k));
  }
}
