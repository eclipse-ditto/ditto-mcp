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
import { AppConfigSchema } from "../config/schema.js";
import { withIngestStore } from "./ingest-store.js";
import { buildIndex, metaFor } from "./build-index.js";
import { buildKnowledgeService } from "./build.js";
import { IngestError } from "./ingest-error.js";
import type { KnowledgeSource, Chunk } from "./types.js";
import type { EmbeddingProvider } from "./embedding.js";

const fake: EmbeddingProvider = {
  dim: 3,
  embed: async (texts) => texts.map((t) =>
    /reconnect|oom|memory/i.test(t) ? [1, 0, 0] : /policy|access/i.test(t) ? [0, 1, 0] : [0, 0, 1]),
};
const chunk = (id: string, text: string): Chunk => ({ id, source: "local", title: "T", text, cite: id });
const src: KnowledgeSource = { id: "local", loadChunks: async () => [
  chunk("local#0", "Netty leak out of memory crash"), chunk("local#1", "policy access control")] };

let db: Awaited<ReturnType<typeof startPgVector>>;
beforeAll(async () => { db = await startPgVector(); }, 120000);
afterAll(async () => { await db?.stop(); });

// Helpers
const q = async (sql: string, p: unknown[] = []) => {
  const c = new pg.Client({ connectionString: db.connectionString });
  await c.connect();
  try {
    return (await c.query(sql, p)).rows;
  } finally {
    await c.end();
  }
};
const exists = (t: string) => q("SELECT to_regclass($1) AS r", [t]).then((r) => r[0].r !== null);

function cfg(table = "e2e") {
  return AppConfigSchema.parse({
    knowledge: {
      retriever: "hybrid", embedding: { dim: 3 },
      publicSource: { enabled: false }, localDir: { enabled: false },
      store: { kind: "pgvector", pgvector: { connectionString: db.connectionString, table } },
    },
  });
}

describe("pgvector end-to-end", () => {
  it("ingest populates pg; server serves hybrid search from it", async () => {
    await withIngestStore(cfg(), async (store) => {
      await buildIndex([src], store, fake, metaFor(cfg(), fake));
    });
    const svc = await buildKnowledgeService(cfg(), { embeddingProvider: fake });
    expect(svc).toBeDefined();
    const hits = await svc!.search("why does it die on reconnect", 2);
    expect(hits[0].chunk.text.toLowerCase()).toContain("out of memory");
    expect(hits[0].matchedBy.length).toBeGreaterThan(0);
  });

  it("never-built pg store → buildKnowledgeService returns undefined (no auto-write)", async () => {
    const table = `empty_${Math.floor(performance.now())}`;
    const svc = await buildKnowledgeService(cfg(table), { embeddingProvider: fake });
    expect(svc).toBeUndefined(); // Server does NOT auto-build for pgvector.
    expect(await exists(`${table}_chunks`)).toBe(false); // ...nor create its tables.
  });

  it("a failed ingest leaves the live index serving the old data", async () => {
    const table = `keep_${Math.floor(performance.now())}`;
    // Good ingest first
    await withIngestStore(cfg(table), async (store) => {
      await buildIndex([src], store, fake, metaFor(cfg(table), fake));
    });
    // Failed ingest
    await expect(
      withIngestStore(cfg(table), async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow(/boom/);
    // Live index still serves old data
    const svc = await buildKnowledgeService(cfg(table), { embeddingProvider: fake });
    expect(svc).toBeDefined();
    const hits = await svc!.search("why does it die on reconnect", 2);
    expect(hits[0].chunk.text.toLowerCase()).toContain("out of memory");
    // Staging tables are cleaned up
    expect(await exists(`${table}_staging_chunks`)).toBe(false);
  });

  it("a second ingest on the same table fails fast; other tables are not blocked", async () => {
    const tableA = `lock_a_${Math.floor(performance.now())}`;
    const tableB = `lock_b_${Math.floor(performance.now())}`;

    let resolveStartedA!: () => void;
    let resolveGateA!: () => void;
    const startedA = new Promise<void>((r) => { resolveStartedA = r; });
    const gateA = new Promise<void>((r) => { resolveGateA = r; });

    // Run A on lock_a with a fn that resolves startedA() then awaits gateA
    const runA = (async () => {
      try {
        await withIngestStore(cfg(tableA), async (store) => {
          resolveStartedA();
          await gateA;
          await buildIndex([src], store, fake, metaFor(cfg(tableA), fake));
        });
      } catch (err) {
        resolveStartedA(); // make sure to resolve even on error
        throw err;
      }
    })();

    try {
      // Wait for A to acquire the lock
      await startedA;

      // Second ingest on lock_a should fail fast with IngestError
      await expect(
        withIngestStore(cfg(tableA), async (store) => {
          await buildIndex([src], store, fake, metaFor(cfg(tableA), fake));
        })
      ).rejects.toThrow(IngestError);

      await expect(
        withIngestStore(cfg(tableA), async () => {})
      ).rejects.toThrow(/another ingest is running/);

      // Other table is not blocked
      await withIngestStore(cfg(tableB), async (store) => {
        await buildIndex([src], store, fake, metaFor(cfg(tableB), fake));
      });

      // Release gateA; A builds and resolves
      resolveGateA();
      await runA;

      // A third ingest on lock_a now succeeds (lock released)
      await withIngestStore(cfg(tableA), async (store) => {
        await buildIndex([src], store, fake, metaFor(cfg(tableA), fake));
      });
    } finally {
      // Make sure to release gateA if something fails
      resolveGateA();
      await runA.catch(() => {}); // Ensure runA completes
    }
  });

  it("a lost ingest lock fails the ingest and leaves the live index untouched", async () => {
    // Good ingest first
    await withIngestStore(cfg("lost"), async (s) => {
      await buildIndex([src], s, fake, metaFor(cfg("lost"), fake));
    });

    // Run A builds different data, so a swap that should not have happened would show.
    const replacement: KnowledgeSource = { id: "local", loadChunks: async () => [
      chunk("local#0", "a replacement document about sharding")] };
    let resolveStarted!: () => void;
    let resolveGate!: () => void;
    const started = new Promise<void>((r) => { resolveStarted = r; });
    const gate = new Promise<void>((r) => { resolveGate = r; });

    const runA = (async () => {
      try {
        await withIngestStore(cfg("lost"), async (s) => {
          await buildIndex([replacement], s, fake, metaFor(cfg("lost"), fake));
          resolveStarted();
          await gate;
        });
      } catch (err) {
        resolveStarted(); // make sure to resolve even on error
        throw err;
      }
    })();

    try {
      await started;
      // What an idle-session timeout, a pooler or a failover does to the idle lock session.
      const killed = await q(
        "SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype = 'advisory' AND granted",
      );
      expect(killed).toEqual([{ pg_terminate_backend: true }]);
      resolveGate();
      await expect(runA).rejects.toThrow(IngestError);
      await expect(runA).rejects.toThrow(/lost the ingest lock/);
    } finally {
      resolveGate();
      await runA.catch(() => {});
    }

    // Live index still serves the old data
    const svc = await buildKnowledgeService(cfg("lost"), { embeddingProvider: fake });
    expect(svc).toBeDefined();
    const hits = await svc!.search("why does it die on reconnect", 2);
    expect(hits[0].chunk.text.toLowerCase()).toContain("out of memory");
    // Staging is left alone: without the lock it may belong to another run
    expect(await exists("lost_staging_chunks")).toBe(true);
  });

  it("a lock lost while the vector index builds fails the ingest and leaves the live index untouched", async () => {
    // The HNSW build can run for minutes; the lock must be checked after it, not before.
    await withIngestStore(cfg("ixlost"), async (s) => {
      await buildIndex([src], s, fake, metaFor(cfg("ixlost"), fake));
    });
    const replacement: KnowledgeSource = { id: "local", loadChunks: async () => [
      chunk("local#0", "a replacement document about sharding")] };
    // Holding ROW EXCLUSIVE on the staging vec table makes CREATE INDEX (SHARE) wait: a slow build.
    const blocker = new pg.Client({ connectionString: db.connectionString });
    await blocker.connect();
    try {
      const runA = withIngestStore(cfg("ixlost"), async (s) => {
        await buildIndex([replacement], s, fake, metaFor(cfg("ixlost"), fake));
        await blocker.query("BEGIN");
        await blocker.query("LOCK TABLE ixlost_staging_vec IN ROW EXCLUSIVE MODE");
      });
      for (let i = 0; i < 100; i++) {
        const [{ n }] = await q(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE 'CREATE INDEX%'",
        );
        if (n > 0) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      const killed = await q(
        "SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype = 'advisory' AND granted",
      );
      expect(killed).toEqual([{ pg_terminate_backend: true }]);
      await blocker.query("COMMIT");
      await expect(runA).rejects.toThrow(/lost the ingest lock/);
    } finally {
      await blocker.end();
    }
    const svc = await buildKnowledgeService(cfg("ixlost"), { embeddingProvider: fake });
    const hits = await svc!.search("why does it die on reconnect", 2);
    expect(hits[0].chunk.text.toLowerCase()).toContain("out of memory");
  });

  it("refuses searches after a live re-ingest that no longer matches the config, until one does", async () => {
    // A running server reads whatever the swap put live; check it like at startup.
    const table = `live_${Math.floor(performance.now())}`;
    const ingest = (c: ReturnType<typeof cfg>, embedder?: EmbeddingProvider) =>
      withIngestStore(c, async (s) => { await buildIndex([src], s, embedder, metaFor(c, embedder)); });
    await ingest(cfg(table), fake);
    const svc = await buildKnowledgeService(cfg(table), { embeddingProvider: fake });
    expect((await svc!.search("why does it die on reconnect", 2)).length).toBeGreaterThan(0);

    // Same dim, another model: queries would be embedded with the wrong model, ranking silently off.
    const otherModel = cfg(table);
    otherModel.knowledge.embedding.model = "other/model";
    await ingest(otherModel, fake);
    await expect(svc!.search("why does it die on reconnect", 2)).rejects.toThrow(
      /re-ingested with retriever=hybrid, model=other\/model, dim=3.*configured for retriever=hybrid, model=Xenova\/bge-small-en-v1\.5, dim=3/,
    );

    // FTS-only: no _vec table at all.
    const ftsOnly = cfg(table);
    ftsOnly.knowledge.retriever = "fts";
    await ingest(ftsOnly);
    await expect(svc!.search("why does it die on reconnect", 2)).rejects.toThrow(/re-ingested with retriever=fts,/);

    // A matching ingest puts it back in service without a restart.
    await ingest(cfg(table), fake);
    const hits = await svc!.search("why does it die on reconnect", 2);
    expect(hits[0].chunk.text.toLowerCase()).toContain("out of memory");
  });

  it("lock is released when connect() throws (no leak)", async () => {
    // Regression: lock leaked when staging.connect threw, causing retry to report 'another ingest'.
    // First call: invalid prefix → connect throws → lock released.
    await expect(
      withIngestStore(cfg("ditto-kn"), async () => {})
    ).rejects.toThrow(/invalid pgvector table prefix/);
    // Second call: same error (not 'another ingest is running').
    await expect(
      withIngestStore(cfg("ditto-kn"), async () => {})
    ).rejects.toThrow(/invalid pgvector table prefix/);
  });
});
