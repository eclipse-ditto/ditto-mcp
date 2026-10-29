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

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { startPgVector } from "./pg-testcontainer.js";
import { PgKnowledgeStore } from "./pg-knowledge-store.js";
import type { Chunk } from "./types.js";

const chunk = (id: string, text: string): Chunk => ({ id, source: "s", title: "T", text, cite: `https://x/${id}` });

let db: Awaited<ReturnType<typeof startPgVector>>;
beforeAll(async () => { db = await startPgVector(); }, 120000);
afterAll(async () => { await db?.stop(); });

// A writable store: only an ingest's staging store creates and writes tables.
async function fresh() {
  const store = await PgKnowledgeStore.connect(db.connectionString, `t_${Math.floor(performance.now())}`, { staging: true });
  await store.reset();
  return store;
}

describe("PgKnowledgeStore", () => {
  it("addChunks + getChunk + isPopulated", async () => {
    const s = await fresh();
    expect(await s.isPopulated()).toBe(false);
    await s.addChunks([chunk("a", "netty out of memory")]);
    expect(await s.isPopulated()).toBe(true);
    expect((await s.getChunk("a"))?.text).toBe("netty out of memory");
    await s.close();
  });

  it("ftsSearch ranks keyword matches", async () => {
    const s = await fresh();
    await s.addChunks([chunk("a", "netty leak out of memory crash"), chunk("b", "policy access control")]);
    expect((await s.ftsSearch("memory crash", 5))[0]).toBe("a");
    expect(await s.ftsSearch("zzznope", 5)).toEqual([]);
    await s.close();
  });

  it("vectorSearch returns nearest; hasVectors reflects state", async () => {
    const s = await fresh();
    await s.ensureVectorTable(3);
    expect(await s.hasVectors()).toBe(false);
    await s.addChunks([chunk("x", "a"), chunk("y", "b")]);
    await s.upsertVectors([{ id: "x", vector: [1, 0, 0] }, { id: "y", vector: [0, 1, 0] }]);
    expect(await s.hasVectors()).toBe(true);
    expect((await s.vectorSearch([1, 0, 0], 1))[0].id).toBe("x");
    await s.close();
  });

  it("meta round-trip + reset clears everything", async () => {
    const s = await fresh();
    await s.setMeta({ schemaVersion: 1, retriever: "fts", complete: true });
    expect((await s.getMeta())?.complete).toBe(true);
    await s.addChunks([chunk("a", "x")]);
    await s.reset();
    expect(await s.isPopulated()).toBe(false);
    expect(await s.getMeta()).toBeUndefined();
    await s.close();
  });

  it("reset() drops vec table → re-ingest can change dim", async () => {
    const s = await fresh();
    await s.ensureVectorTable(3);
    await s.addChunks([chunk("x", "a")]);
    await s.upsertVectors([{ id: "x", vector: [1, 0, 0] }]);
    expect(await s.hasVectors()).toBe(true);
    await s.reset();
    expect(await s.isPopulated()).toBe(false);
    // Re-ingest at a different dim succeeds (proves vec table was dropped + recreated).
    await s.ensureVectorTable(4);
    await s.addChunks([chunk("y", "b")]);
    await s.upsertVectors([{ id: "y", vector: [0, 1, 0, 1] }]);
    expect(await s.hasVectors()).toBe(true);
    expect((await s.vectorSearch([0, 1, 0, 1], 1))[0].id).toBe("y");
    await s.close();
  });

  it("ftsSearch uses OR semantics (chunk matches ANY token)", async () => {
    const s = await fresh();
    await s.addChunks([chunk("a", "netty out of memory crash"), chunk("b", "policy access control")]);
    // 2-term query where chunk b matches only "policy" (not "memory") → still returned (OR recall).
    const hits = await s.ftsSearch("memory policy", 5);
    expect(hits).toContain("a"); // matches "memory"
    expect(hits).toContain("b"); // matches "policy"
    await s.close();
  });

  it("survives the server terminating an idle pooled connection", async () => {
    const s = await fresh();
    await s.isPopulated(); // leaves an idle client in the pool
    // What a Postgres restart or RDS failover does to idle connections (57P01).
    const admin = new pg.Client({ connectionString: db.connectionString });
    await admin.connect();
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()",
    );
    await admin.end();
    await new Promise((r) => setTimeout(r, 500)); // let the pool see the dropped socket
    expect(await s.isPopulated()).toBe(false); // pool replaced the dead client
    await s.close();
  });

  // Helpers for staging tests
  const q = async (sql: string, p: unknown[] = []) => {
    const c = new pg.Client({ connectionString: db.connectionString });
    await c.connect();
    try {
      return (await c.query(sql, p)).rows;
    } finally {
      await c.end();
    }
  };
  const indexes = (t: string) => q("SELECT indexname FROM pg_indexes WHERE tablename = $1 ORDER BY 1", [t]).then((r) => r.map((x) => x.indexname));
  const exists = (t: string) => q("SELECT to_regclass($1) AS r", [t]).then((r) => r[0].r !== null);

  it("rejects a table prefix longer than 40 chars", async () => {
    await expect(PgKnowledgeStore.connect(db.connectionString, "a".repeat(41))).rejects.toThrow(/max 40/);
  });

  it("staging store swaps into the live prefix under live index names", async () => {
    const live = `sw_${Math.floor(performance.now())}`;
    const staging = await PgKnowledgeStore.connect(db.connectionString, live, { staging: true });
    await staging.ensureVectorTable(3);
    await staging.addChunks([chunk("x", "netty")]);
    await staging.upsertVectors([{ id: "x", vector: [1, 0, 0] }]);
    await staging.setMeta({ schemaVersion: 1, retriever: "hybrid", complete: true });
    await staging.swapIntoLive();
    await staging.close();

    const liveStore = await PgKnowledgeStore.connect(db.connectionString, live);
    expect(await liveStore.getChunk("x")).toBeDefined();
    expect((await liveStore.vectorSearch([1, 0, 0], 1))[0].id).toBe("x");
    await liveStore.close();

    expect(await indexes(`${live}_chunks`)).toEqual([`${live}_chunks_pkey`, `${live}_chunks_tsv`]);
    expect(await indexes(`${live}_vec`)).toEqual([`${live}_vec_idx`, `${live}_vec_pkey`]);
    expect(await indexes(`${live}_meta`)).toEqual([`${live}_meta_pkey`]);
    expect(await exists(`${live}_staging_chunks`)).toBe(false);
  });

  it("a second swap replaces the data and keeps live index names", async () => {
    const live = `sw_${Math.floor(performance.now())}`;
    // First swap with chunk "x" at dim 3
    const staging1 = await PgKnowledgeStore.connect(db.connectionString, live, { staging: true });
    await staging1.ensureVectorTable(3);
    await staging1.addChunks([chunk("x", "netty")]);
    await staging1.upsertVectors([{ id: "x", vector: [1, 0, 0] }]);
    await staging1.swapIntoLive();
    await staging1.close();

    // Second swap with chunk "y" at dim 4
    const staging2 = await PgKnowledgeStore.connect(db.connectionString, live, { staging: true });
    await staging2.ensureVectorTable(4);
    await staging2.addChunks([chunk("y", "memory")]);
    await staging2.upsertVectors([{ id: "y", vector: [0, 1, 0, 1] }]);
    await staging2.swapIntoLive();
    await staging2.close();

    const liveStore = await PgKnowledgeStore.connect(db.connectionString, live);
    expect(await liveStore.getChunk("x")).toBeUndefined();
    expect(await liveStore.getChunk("y")).toBeDefined();
    expect((await liveStore.vectorSearch([0, 1, 0, 1], 1))[0].id).toBe("y");
    await liveStore.close();

    expect(await indexes(`${live}_chunks`)).toEqual([`${live}_chunks_pkey`, `${live}_chunks_tsv`]);
    expect(await indexes(`${live}_vec`)).toEqual([`${live}_vec_idx`, `${live}_vec_pkey`]);
    expect(await indexes(`${live}_meta`)).toEqual([`${live}_meta_pkey`]);
  });

  it("swapping an fts-only build removes the live vector table", async () => {
    const live = `sw_${Math.floor(performance.now())}`;
    // First swap with vectors
    const staging1 = await PgKnowledgeStore.connect(db.connectionString, live, { staging: true });
    await staging1.ensureVectorTable(3);
    await staging1.addChunks([chunk("x", "netty")]);
    await staging1.upsertVectors([{ id: "x", vector: [1, 0, 0] }]);
    await staging1.swapIntoLive();
    await staging1.close();

    // Second swap without vectors
    const staging2 = await PgKnowledgeStore.connect(db.connectionString, live, { staging: true });
    await staging2.addChunks([chunk("y", "memory")]);
    await staging2.swapIntoLive();
    await staging2.close();

    expect(await exists(`${live}_vec`)).toBe(false);
    const liveStore = await PgKnowledgeStore.connect(db.connectionString, live);
    expect(await liveStore.ftsSearch("memory", 1)).toContain("y");
    await liveStore.close();
  });

  it("swapIntoLive rolls back and leaves live intact when it fails", async () => {
    const live = `sw_${Math.floor(performance.now())}`;
    const staging = await PgKnowledgeStore.connect(db.connectionString, live, { staging: true });
    await staging.addChunks([chunk("x", "netty")]);
    await staging.swapIntoLive();
    // The staging tables were renamed away, so this swap fails after dropping the live tables.
    await expect(staging.swapIntoLive()).rejects.toThrow(/does not exist/);
    await staging.close();

    const liveStore = await PgKnowledgeStore.connect(db.connectionString, live);
    expect(await liveStore.getChunk("x")).toBeDefined();
    await liveStore.close();
  });

  it("builds the vector index at the swap, not while vectors load", async () => {
    // Every row inserted into a live HNSW index updates it; building it once at the end is cheaper.
    const live = `ix_${Math.floor(performance.now())}`;
    const staging = await PgKnowledgeStore.connect(db.connectionString, live, { staging: true });
    await staging.ensureVectorTable(3);
    await staging.addChunks([chunk("x", "netty")]);
    await staging.upsertVectors([{ id: "x", vector: [1, 0, 0] }]);
    expect(await indexes(`${live}_staging_vec`)).toEqual([`${live}_staging_vec_pkey`]);
    await staging.swapIntoLive();
    await staging.close();
    expect(await indexes(`${live}_vec`)).toEqual([`${live}_vec_idx`, `${live}_vec_pkey`]);
  });

  it("loads more rows than one insert batch, keeping the last of an id repeated across batches", async () => {
    const s = await fresh();
    await s.ensureVectorTable(3);
    const rows = Array.from({ length: 1203 }, (_, i) => chunk(`c${i}`, `text ${i}`));
    rows.push(chunk("c10", "replaced")); // c10 first sits in batch 1, its replacement in batch 3
    await s.addChunks(rows);
    await s.upsertVectors(rows.map((c, i) => ({ id: c.id, vector: [1, i, 0] })));
    expect((await s.ftsSearch("text", 2000)).length).toBe(1202); // all but the replaced c10
    expect((await s.getChunk("c10"))?.text).toBe("replaced");
    expect((await s.getChunk("c1202"))?.text).toBe("text 1202");
    expect((await s.vectorSearch([1, 0, 0], 2000)).length).toBe(1203);
    await s.close();
  });

  it("keeps the last of a repeated id within one batch of chunks or vectors", async () => {
    const s = await fresh();
    await s.ensureVectorTable(3);
    await s.addChunks([chunk("a", "first"), chunk("b", "other"), chunk("a", "second")]);
    await s.upsertVectors([{ id: "a", vector: [1, 0, 0] }, { id: "a", vector: [0, 1, 0] }]);
    expect((await s.getChunk("a"))?.text).toBe("second");
    expect((await s.vectorSearch([0, 1, 0], 1))[0]).toEqual({ id: "a", distance: 0 });
    await s.close();
  });

  it("dropTables removes the store's tables", async () => {
    const live = `sw_${Math.floor(performance.now())}`;
    const staging = await PgKnowledgeStore.connect(db.connectionString, live, { staging: true });
    await staging.addChunks([chunk("x", "netty")]);
    await staging.dropTables();
    await staging.close();

    expect(await exists(`${live}_staging_chunks`)).toBe(false);
    expect(await exists(`${live}_staging_meta`)).toBe(false);
  });

  it("swapIntoLive refuses on a non-staging store", async () => {
    const live = `sw_${Math.floor(performance.now())}`;
    const staging = await PgKnowledgeStore.connect(db.connectionString, live, { staging: true });
    await staging.swapIntoLive();
    await staging.close();
    const s = await PgKnowledgeStore.connect(db.connectionString, live);
    await expect(s.swapIntoLive()).rejects.toThrow(/staging/);
    await s.close();
  });

  it("serves a built index with a SELECT-only role", async () => {
    // Postgres checks CREATE on the schema before IF NOT EXISTS, so a serving connect that
    // runs DDL fails for a least-privilege role (and on PG15+ public grants no CREATE).
    const n = Math.floor(performance.now());
    const live = `ro_${n}`;
    const staging = await PgKnowledgeStore.connect(db.connectionString, live, { staging: true });
    await staging.addChunks([chunk("x", "netty out of memory")]);
    await staging.setMeta({ schemaVersion: 1, retriever: "fts", complete: true });
    await staging.swapIntoLive();
    await staging.close();
    await q(`CREATE ROLE reader_${n} LOGIN PASSWORD 'r'`);
    await q(`GRANT SELECT ON ${live}_chunks, ${live}_meta TO reader_${n}`);
    const url = new URL(db.connectionString);
    url.username = `reader_${n}`;
    url.password = "r";

    const s = await PgKnowledgeStore.connect(url.toString(), live);
    expect(await s.isPopulated()).toBe(true);
    expect(await s.ftsSearch("memory", 5)).toEqual(["x"]);
    expect(await s.getMeta()).toBeDefined();
    await s.close();
  });

  it("keeps a serving role's table grants across re-ingests, a first vector table included", async () => {
    // The swap replaces the live tables; their grants must not go with them.
    const n = Math.floor(performance.now());
    const live = `gr_${n}`;
    const ingest = async (withVectors: boolean, text: string) => {
      const staging = await PgKnowledgeStore.connect(db.connectionString, live, { staging: true });
      if (withVectors) await staging.ensureVectorTable(3);
      await staging.addChunks([chunk("x", text)]);
      if (withVectors) await staging.upsertVectors([{ id: "x", vector: [1, 0, 0] }]);
      await staging.setMeta({ schemaVersion: 1, retriever: withVectors ? "hybrid" : "fts", complete: true });
      await staging.swapIntoLive();
      await staging.close();
    };
    await ingest(false, "first"); // FTS-only: no _vec to grant on yet
    await q(`CREATE ROLE reader_${n} LOGIN PASSWORD 'r'`);
    await q(`GRANT SELECT ON ${live}_chunks, ${live}_meta TO reader_${n}`);
    const url = new URL(db.connectionString);
    url.username = `reader_${n}`;
    url.password = "r";

    for (const text of ["second", "third"]) {
      await ingest(true, text);
      const s = await PgKnowledgeStore.connect(url.toString(), live);
      expect((await s.getChunk("x"))?.text).toBe(text);
      expect((await s.vectorSearch([1, 0, 0], 1))[0].id).toBe("x");
      await s.close();
    }
  });

  it("names the missing table and ingest when serving an index that was never built", async () => {
    await expect(PgKnowledgeStore.connect(db.connectionString, "never_built"))
      .rejects.toThrow(/never_built_chunks.*ingest/);
    expect(await exists("never_built_chunks")).toBe(false);
  });
});
