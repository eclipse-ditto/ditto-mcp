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

import { describe, it, expect, afterEach } from "vitest";
import { KnowledgeService } from "./knowledge-service.js";
import { SqliteKnowledgeStore } from "./sqlite-knowledge-store.js";
import { FtsRetriever } from "./fts-retriever.js";
import { VectorRetriever } from "./vector-retriever.js";
import { HybridRetriever } from "./hybrid-retriever.js";
import { buildIndex } from "./build-index.js";
import type { KnowledgeStore } from "./knowledge-store.js";
import type { KnowledgeSource, Chunk, RetrievedChunk, Retriever } from "./types.js";

const src = (id: string, chunks: Chunk[]): KnowledgeSource => ({ id, loadChunks: async () => chunks });
const chunk = (id: string, text: string): Chunk => ({ id, source: "s", title: "T", text, cite: `https://x/${id}` });

// A chunk positioned in a document: id `pub#<n>`, grouped by `cite`.
const c = (n: number, cite: string, text = `text ${n}`): Chunk => ({
  id: `pub#${n}`,
  source: "pub",
  title: `T${n}`,
  text,
  cite,
});

const stubRetriever = (anchors: RetrievedChunk[]): Retriever => ({
  kind: "stub",
  search: async () => anchors,
  rank: async () => anchors.map((a) => ({ id: a.chunk.id, matchedBy: a.matchedBy })),
});

/** The store, counting the calls that load chunks. */
function countingLoads(inner: KnowledgeStore) {
  const calls = { getChunk: 0, getChunks: 0 };
  const store = new Proxy(inner, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (typeof value !== "function") return value;
      if (prop === "getChunk" || prop === "getChunks") calls[prop]++;
      return value.bind(target);
    },
  });
  return { store, calls };
}

let store: SqliteKnowledgeStore;
afterEach(async () => await store?.close());

describe("KnowledgeService", () => {
  it("searches via the retriever and gets chunks via the store", async () => {
    store = new SqliteKnowledgeStore();
    await buildIndex([src("s1", [chunk("a", "reconnect memory crash")])], store);
    const svc = new KnowledgeService(store, new FtsRetriever(store));
    const hits = await svc.search("memory", 5);
    expect(hits[0].chunk.id).toBe("a");
    expect((await svc.getChunk("a"))?.text).toBe("reconnect memory crash");
  });
});

describe("KnowledgeService chunk loading", () => {
  it("loads a hybrid search's anchors in one batch and their neighbors in one more", async () => {
    // One query per chunk meant ~50 sequential round trips on pgvector for limit=5, context=1.
    store = new SqliteKnowledgeStore();
    const embedder = { dim: 3, embed: async (t: string[]) => t.map(() => [1, 0, 0]) };
    const doc = Array.from({ length: 30 }, (_, n) => c(n, "A", `memory crash part ${n}`));
    await buildIndex([src("pub", doc)], store, embedder, { retriever: "hybrid", embeddingModel: "m", embeddingDim: 3 });
    const { store: counted, calls } = countingLoads(store);
    const svc = new KnowledgeService(counted, new HybridRetriever(counted, [
      new FtsRetriever(counted), new VectorRetriever(counted, embedder)]));
    const hits = await svc.search("memory crash", 5, { context: 1 });
    expect(hits.filter((h) => h.role === "anchor")).toHaveLength(5);
    expect(hits.some((h) => h.role === "context")).toBe(true);
    expect(calls).toEqual({ getChunk: 0, getChunks: 2 });
  });
});

describe("KnowledgeService neighbor expansion", () => {
  it("context=0 returns only anchors", async () => {
    store = new SqliteKnowledgeStore();
    await store.addChunks([c(0, "A"), c(1, "A"), c(2, "A")]);
    const svc = new KnowledgeService(store, stubRetriever([{ chunk: c(1, "A"), matchedBy: ["fts"] }]));
    const hits = await svc.search("q", 5, { context: 0 });
    expect(hits.map((h) => h.chunk.id)).toEqual(["pub#1"]);
  });

  it("expands to same-cite neighbors in ordinal order, tagged by role", async () => {
    store = new SqliteKnowledgeStore();
    await store.addChunks([c(0, "A"), c(1, "A"), c(2, "A")]);
    const svc = new KnowledgeService(store, stubRetriever([{ chunk: c(1, "A"), matchedBy: ["vector"] }]));
    const hits = await svc.search("q", 5, { context: 1 });
    expect(hits.map((h) => h.chunk.id)).toEqual(["pub#0", "pub#1", "pub#2"]);
    expect(hits.map((h) => h.role)).toEqual(["context", "anchor", "context"]);
    expect(hits.find((h) => h.chunk.id === "pub#1")!.matchedBy).toEqual(["vector"]);
  });

  it("does not cross document boundaries (different cite)", async () => {
    store = new SqliteKnowledgeStore();
    await store.addChunks([c(0, "A"), c(1, "A"), c(2, "A"), c(3, "B"), c(4, "B")]);
    // anchor pub#3 = first chunk of doc B; pub#2 is numerically adjacent but belongs to doc A.
    const svc = new KnowledgeService(store, stubRetriever([{ chunk: c(3, "B"), matchedBy: ["fts"] }]));
    const hits = await svc.search("q", 5, { context: 1 });
    expect(hits.map((h) => h.chunk.id)).toEqual(["pub#3", "pub#4"]);
  });

  it("dedups and merges overlapping anchor windows into one contiguous span", async () => {
    store = new SqliteKnowledgeStore();
    await store.addChunks([c(0, "A"), c(1, "A"), c(2, "A"), c(3, "A")]);
    const svc = new KnowledgeService(
      store,
      stubRetriever([
        { chunk: c(1, "A"), matchedBy: ["fts"] },
        { chunk: c(2, "A"), matchedBy: ["vector"] },
      ]),
    );
    const hits = await svc.search("q", 5, { context: 1 });
    expect(hits.map((h) => h.chunk.id)).toEqual(["pub#0", "pub#1", "pub#2", "pub#3"]);
    expect(hits.map((h) => h.role)).toEqual(["context", "anchor", "anchor", "context"]);
    expect(new Set(hits.map((h) => h.chunk.id)).size).toBe(hits.length); // no dupes
  });
});
