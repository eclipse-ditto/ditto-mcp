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

import { describe, it, expect } from "vitest";
import { HybridRetriever } from "./hybrid-retriever.js";
import type { Ranker, Chunk } from "./types.js";

const chunk = (id: string): Chunk => ({
  id, source: "s", title: id, text: id, cite: `https://x/${id}`,
});

// Fake legs returning fixed ranked lists.
function fixed(kind: string, ids: string[]): Ranker {
  return { rank: async (_q, k) => ids.slice(0, k).map((id) => ({ id, matchedBy: [kind] })) };
}

// A store that has every chunk and records which ids were loaded.
const loaded: string[][] = [];
const store = {
  getChunks: async (ids: string[]) => {
    loaded.push(ids);
    return new Map(ids.map((id) => [id, chunk(id)]));
  },
};

describe("HybridRetriever", () => {
  it("has kind 'hybrid'", () => {
    const h = new HybridRetriever(store, [fixed("fts", ["a"]), fixed("vector", ["b"])]);
    expect(h.kind).toBe("hybrid");
  });

  it("fuses two ranked lists via RRF and dedupes", async () => {
    // 'b' appears in both lists -> should rank at/near the top after fusion.
    const a = fixed("fts", ["a", "b", "c"]);
    const d = fixed("vector", ["b", "d", "e"]);
    const h = new HybridRetriever(store, [a, d]);
    const hits = await h.search("q", 3);
    const ids = hits.map((rc) => rc.chunk.id);
    expect(ids[0]).toBe("b");
    expect(new Set(ids).size).toBe(ids.length); // no duplicates
    expect(hits).toHaveLength(3);
  });

  it("fuses a chunk that both retrievers rank just below the requested count", async () => {
    // Fetching only k candidates per leg dropped 'x' (4th in both lists for k=3) before fusion,
    // although RRF scores it 2/64, above any single-list first place (1/61).
    const h = new HybridRetriever(store, [fixed("fts", ["a", "b", "c", "x"]), fixed("vector", ["d", "e", "f", "x"])]);
    const hits = await h.search("q", 3);
    expect(hits.map((rc) => rc.chunk.id)).toEqual(["x", "a", "d"]);
    expect(hits[0].matchedBy).toEqual(["fts", "vector"]);
  });

  it("loads only the fused top k chunks, in one batch", async () => {
    // Loading every leg's candidates (2 x depth) and then discarding most of them cost one
    // query per candidate on pgvector.
    loaded.length = 0;
    const h = new HybridRetriever(store, [fixed("fts", ["a", "b", "c", "x"]), fixed("vector", ["d", "e", "f", "x"])]);
    await h.search("q", 3);
    expect(loaded).toEqual([["x", "a", "d"]]);
  });

  it("merges matchedBy from both retrievers for duplicates", async () => {
    // 'b' appears in both lists -> matchedBy should be ["fts","vector"]
    const a = fixed("fts", ["a", "b", "c"]);
    const d = fixed("vector", ["b", "d", "e"]);
    const h = new HybridRetriever(store, [a, d]);
    const hits = await h.search("q", 5);
    const b = hits.find((rc) => rc.chunk.id === "b");
    expect(b).toBeDefined();
    expect(b!.matchedBy).toEqual(["fts", "vector"]);
    // Single-source chunks should have single matchedBy
    const a_hit = hits.find((rc) => rc.chunk.id === "a");
    expect(a_hit!.matchedBy).toEqual(["fts"]);
    const d_hit = hits.find((rc) => rc.chunk.id === "d");
    expect(d_hit!.matchedBy).toEqual(["vector"]);
  });

});
