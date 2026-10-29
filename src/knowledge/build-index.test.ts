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
import { buildIndex } from "./build-index.js";
import { IngestError } from "./ingest-error.js";
import { SqliteKnowledgeStore } from "./sqlite-knowledge-store.js";
import type { KnowledgeSource, Chunk } from "./types.js";
import type { EmbeddingProvider } from "./embedding.js";

const src = (id: string, chunks: Chunk[]): KnowledgeSource => ({ id, loadChunks: async () => chunks });
const chunk = (id: string, text: string): Chunk => ({ id, source: "s", title: "T", text, cite: `https://x/${id}` });
const fake: EmbeddingProvider = { dim: 3, embed: async (t) => t.map(() => [1, 0, 0]) };
const skipping = (id: string, item: string, chunks: Chunk[]): KnowledgeSource => ({
  id,
  loadChunks: async (_s, onSkip) => {
    onSkip?.(item, "503");
    return chunks;
  },
});

let store: SqliteKnowledgeStore;
afterEach(async () => await store?.close());

describe("buildIndex", () => {
  it("adds chunks (fts) with no embedder", async () => {
    store = new SqliteKnowledgeStore();
    await buildIndex([src("s1", [chunk("a", "reconnect memory")])], store);
    expect(await store.isPopulated()).toBe(true);
    expect((await store.ftsSearch("memory", 5))[0]).toBe("a");
    expect(await store.vectorSearch([1, 0, 0], 5)).toEqual([]); // no vectors
  });

  it("adds chunks + vectors with an embedder", async () => {
    store = new SqliteKnowledgeStore();
    await buildIndex([src("s1", [chunk("a", "x")])], store, fake);
    expect((await store.vectorSearch([1, 0, 0], 1))[0].id).toBe("a");
  });

  it("refuses to write an empty index", async () => {
    store = new SqliteKnowledgeStore();
    await expect(buildIndex([src("s1", [])], store)).rejects.toThrow(/no chunks/);
    expect(await store.getMeta()).toBeUndefined();
    expect(await store.isPopulated()).toBe(false);
  });

  it("rejects duplicate chunk ids", async () => {
    store = new SqliteKnowledgeStore();
    await expect(
      buildIndex([src("s1", [chunk("a", "x"), chunk("a", "y")])], store),
    ).rejects.toThrow(/duplicate chunk id "a"/);
    expect(await store.getMeta()).toBeUndefined();
  });

  it("rejects two sources with the same id", async () => {
    store = new SqliteKnowledgeStore();
    await expect(
      buildIndex([src("s1", [chunk("a", "x")]), src("s1", [chunk("b", "y")])], store),
    ).rejects.toThrow(/share the id "s1"/);
  });

  it("by default a skipped item fails before anything is written", async () => {
    store = new SqliteKnowledgeStore();
    await expect(
      buildIndex([skipping("s1", "https://x/b", [chunk("a", "x")])], store),
    ).rejects.toThrow(IngestError);
    try {
      await buildIndex([skipping("s1", "https://x/b", [chunk("a", "x")])], store);
    } catch (err) {
      expect(err).toBeInstanceOf(IngestError);
      expect((err as IngestError).skipped).toEqual([
        { source: "s1", item: "https://x/b", reason: "503" },
      ]);
      expect((err as IngestError).message).toContain("s1: https://x/b: 503");
    }
    expect(await store.isPopulated()).toBe(false);
  });

  it("allowSkipped: builds the rest and reports skipped items", async () => {
    store = new SqliteKnowledgeStore();
    const report = await buildIndex(
      [skipping("s1", "https://x/b", [chunk("a", "x")])],
      store,
      undefined,
      undefined,
      { allowSkipped: true },
    );
    expect(report).toEqual({
      chunks: 1,
      skipped: [{ source: "s1", item: "https://x/b", reason: "503" }],
    });
    expect((await store.getMeta())?.complete).toBe(true);
  });

  it("allowFailedSources: a source that throws is left out", async () => {
    store = new SqliteKnowledgeStore();
    const report = await buildIndex(
      [
        {
          id: "bad",
          loadChunks: async () => {
            throw new Error("boom");
          },
        },
        src("ok", [chunk("a", "x")]),
      ],
      store,
      undefined,
      undefined,
      { allowSkipped: true, allowFailedSources: true },
    );
    expect(report.skipped).toEqual([{ source: "bad", item: "(source)", reason: "boom" }]);
    expect(report.chunks).toBe(1);
  });

  it("a source that throws fails with the source id, even with allowSkipped", async () => {
    store = new SqliteKnowledgeStore();
    const sources = [
      {
        id: "bad",
        loadChunks: async () => {
          throw new Error("boom");
        },
      },
      src("ok", [chunk("a", "x")]),
    ];
    await expect(buildIndex(sources, store)).rejects.toThrow(/bad: boom/);
    await expect(buildIndex(sources, store, undefined, undefined, { allowSkipped: true })).rejects.toThrow(
      /bad: boom/,
    );
  });

  it("a failed source's reason includes the error's cause", async () => {
    store = new SqliteKnowledgeStore();
    const sources = [
      {
        id: "bad",
        loadChunks: async () => {
          throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
        },
      },
      src("ok", [chunk("a", "x")]),
    ];
    await expect(buildIndex(sources, store)).rejects.toThrow("bad: fetch failed: ECONNRESET");
    const report = await buildIndex(sources, store, undefined, undefined, {
      allowSkipped: true,
      allowFailedSources: true,
    });
    expect(report.skipped).toEqual([{ source: "bad", item: "(source)", reason: "fetch failed: ECONNRESET" }]);
  });

  it("zero chunks with skipped items shows the reasons in the error", async () => {
    store = new SqliteKnowledgeStore();
    await expect(
      buildIndex(
        [
          {
            id: "bad",
            loadChunks: async () => {
              throw new Error("boom");
            },
          },
        ],
        store,
        undefined,
        undefined,
        { allowSkipped: true, allowFailedSources: true },
      ),
    ).rejects.toThrow(/no chunks[\s\S]*bad: \(source\): boom/);
    try {
      await buildIndex(
        [
          {
            id: "bad",
            loadChunks: async () => {
              throw new Error("boom");
            },
          },
        ],
        store,
        undefined,
        undefined,
        { allowSkipped: true, allowFailedSources: true },
      );
    } catch (err) {
      expect(err).toBeInstanceOf(IngestError);
      expect((err as IngestError).skipped).toEqual([]);
    }
  });
});
