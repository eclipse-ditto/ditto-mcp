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
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppConfigSchema } from "../config/schema.js";
import { withIngestStore } from "./ingest-store.js";
import { SqliteKnowledgeStore } from "./sqlite-knowledge-store.js";

describe("withIngestStore (sqlite)", () => {
  it("builds into a temp file then renames atomically", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ditto-idx-"));
    const path = join(dir, "index.db");
    const config = AppConfigSchema.parse({ knowledge: { store: { kind: "sqlite", sqlite: { path } } } });
    await withIngestStore(config, async (store) => {
      await store.addChunks([{ id: "a", source: "s", title: "T", text: "netty", cite: "x" }]);
      await store.setMeta({ schemaVersion: 1, retriever: "fts", complete: true });
    });
    expect(readdirSync(dir)).toEqual(["index.db"]);
    const s = new SqliteKnowledgeStore(path);
    expect(await s.isPopulated()).toBe(true);
    await s.close();
  });

  it("removes tmp file on error, does not rename, and propagates error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ditto-idx-"));
    const path = join(dir, "index.db");
    const config = AppConfigSchema.parse({ knowledge: { store: { kind: "sqlite", sqlite: { path } } } });
    await expect(
      withIngestStore(config, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(readdirSync(dir)).toEqual([]);
  });

  it("two overlapping ingests on the same path both complete; the last finisher's index is live", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ditto-idx-"));
    const path = join(dir, "index.db");
    const config = AppConfigSchema.parse({ knowledge: { store: { kind: "sqlite", sqlite: { path } } } });
    let releaseA!: () => void;
    const gateA = new Promise<void>((r) => (releaseA = r));
    const meta = { schemaVersion: 1, retriever: "fts", complete: true };
    const a = withIngestStore(config, async (s) => {
      await s.addChunks([{ id: "a", source: "s", title: "T", text: "alpha", cite: "x" }]);
      await s.setMeta(meta);
      await gateA;
    });
    await withIngestStore(config, async (s) => {
      await s.addChunks([{ id: "b", source: "s", title: "T", text: "bravo", cite: "y" }]);
      await s.setMeta(meta);
    });
    releaseA();
    await a;
    const s = new SqliteKnowledgeStore(path);
    expect(await s.getChunk("a")).toBeDefined();
    expect(await s.getChunk("b")).toBeUndefined();
    await s.close();
    expect(readdirSync(dir)).toEqual(["index.db"]);
  });
});
