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

import pg from "pg";
import type { Chunk } from "./types.js";
import { ftsTokens, type IndexMeta, type KnowledgeStore } from "./knowledge-store.js";
import { IngestError } from "./ingest-error.js";

/** A held per-table ingest lock (a session-level advisory lock on a dedicated connection). */
export interface IngestLock {
  /** Throws an IngestError unless the lock has been held without a break since it was taken. */
  assertHeld(): Promise<void>;
  release(): Promise<void>;
}

const INSERT_BATCH = 500;

// ON CONFLICT DO UPDATE refuses to touch a row twice in one statement; keep the last of a
// repeated id, as one upsert per row did.
function lastById<T extends { id: string }>(items: T[]): T[] {
  return [...new Map(items.map((it) => [it.id, it])).values()];
}

/** Re-grant on `to` what others than its owner hold on `from` (none if `from` doesn't exist). */
async function copyGrants(client: pg.PoolClient, from: string, to: string): Promise<void> {
  const grants = await client.query(
    `SELECT a.privilege_type, a.is_grantable,
            CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(r.rolname) END AS grantee
       FROM pg_class c
       CROSS JOIN LATERAL aclexplode(c.relacl) a
       LEFT JOIN pg_roles r ON r.oid = a.grantee
      WHERE c.oid = to_regclass($1) AND a.grantee <> c.relowner`,
    [from],
  );
  for (const g of grants.rows) {
    // privilege_type is a keyword (SELECT, INSERT, ...); grantee comes quoted from quote_ident.
    await client.query(`GRANT ${g.privilege_type} ON ${to} TO ${g.grantee}${g.is_grantable ? " WITH GRANT OPTION" : ""}`);
  }
}

export class PgKnowledgeStore implements KnowledgeStore {
  private constructor(
    private readonly pool: pg.Pool,
    private readonly t: string, // sanitized table prefix
    private vecReady: boolean,
    private readonly livePrefix: string, // the live prefix (without _staging)
    private readonly isStaging: boolean,
  ) {}

  static async lockIngest(connectionString: string, table: string): Promise<IngestLock> {
    // The lock session sits idle for the whole ingest; keepalive probes stop NATs and load
    // balancers from dropping it (the OS default waits two hours before the first probe).
    const client = new pg.Client({ connectionString, keepAlive: true, keepAliveInitialDelayMillis: 30_000 });
    let released = false;
    let lost = false;
    // pg emits this when the client's backend goes away (Postgres restart, failover,
    // idle_session_timeout). Unhandled, it crashes the process.
    client.on("error", (err) => {
      if (!released) lost = true;
      process.stderr.write(`[ditto-mcp ingest] lock client connection lost: ${err.message}\n`);
    });
    client.on("end", () => {
      if (!released) lost = true;
    });
    await client.connect();
    // Unquoted identifiers fold to lowercase: "Ditto_KN" and "ditto_kn" are the same tables.
    const lockKey = `ditto-mcp-ingest:${table.toLowerCase()}`;
    let result: pg.QueryResult;
    try {
      result = await client.query("SELECT pg_try_advisory_lock(hashtext($1)) AS ok", [lockKey]);
    } catch (e) {
      await client.end().catch(() => {});
      throw e;
    }
    if (!result.rows[0].ok) {
      await client.end();
      throw new IngestError(`another ingest is running for pgvector table prefix "${table}"`);
    }
    const lostLock = (cause?: unknown) => new IngestError(
      `lost the ingest lock for pgvector table prefix "${table}"; the live index was not changed — re-run`,
      { cause },
    );
    return {
      async assertHeld() {
        if (lost) throw lostLock();
        // pg.Client never reconnects: a live session has held the lock since it was taken.
        try {
          await client.query("SELECT 1");
        } catch (e) {
          lost = true;
          throw lostLock(e);
        }
      },
      async release() {
        released = true;
        await client.end();
      },
    };
  }

  static async connect(connectionString: string, table: string, opts?: { staging?: boolean }): Promise<PgKnowledgeStore> {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
      throw new Error(`invalid pgvector table prefix: ${table}`);
    }
    if (table.length > 40) {
      throw new Error(`table prefix too long (max 40 chars): ${table}`);
    }
    const isStaging = opts?.staging ?? false;
    const prefix = isStaging ? `${table}_staging` : table;
    const pool = new pg.Pool({ connectionString });
    // pg emits this when an idle client's backend goes away (Postgres restart, failover).
    // Unhandled, it crashes the process; the pool already discards the client and
    // reconnects on the next query.
    pool.on("error", (err) => {
      process.stderr.write(`[ditto-mcp] pgvector idle connection lost: ${err.message}\n`);
    });
    const exists = async (name: string) =>
      (await pool.query("SELECT to_regclass($1) AS reg", [name])).rows[0].reg !== null;
    try {
      // Only an ingest (which writes the staging tables) creates schema. The server just reads:
      // Postgres checks CREATE on the schema before IF NOT EXISTS, so DDL here would fail for a
      // SELECT-only serving role.
      if (isStaging) {
        await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
        await pool.query(
          `CREATE TABLE IF NOT EXISTS ${prefix}_chunks (
             id TEXT PRIMARY KEY, source TEXT, title TEXT, text TEXT, cite TEXT,
             tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(title,'') || ' ' || coalesce(text,''))) STORED
           )`,
        );
        await pool.query(`CREATE INDEX IF NOT EXISTS ${prefix}_chunks_tsv ON ${prefix}_chunks USING GIN (tsv)`);
        await pool.query(`CREATE TABLE IF NOT EXISTS ${prefix}_meta (id INT PRIMARY KEY CHECK (id = 1), json JSONB NOT NULL)`);
      } else {
        const missing = [];
        for (const name of [`${prefix}_chunks`, `${prefix}_meta`]) {
          if (!(await exists(name))) missing.push(name);
        }
        if (missing.length > 0) {
          throw new Error(`pgvector index not built (missing ${missing.join(", ")}); run ingest to build it`);
        }
      }
      return new PgKnowledgeStore(pool, prefix, await exists(`${prefix}_vec`), table, isStaging);
    } catch (e) {
      await pool.end();
      throw e;
    }
  }

  async addChunks(chunks: Chunk[]): Promise<void> {
    await this.insertBatches(lastById(chunks), (client, batch) => client.query(
      `INSERT INTO ${this.t}_chunks (id, source, title, text, cite)
       SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[])
       ON CONFLICT (id) DO UPDATE
         SET source = EXCLUDED.source, title = EXCLUDED.title, text = EXCLUDED.text, cite = EXCLUDED.cite`,
      [batch.map((c) => c.id), batch.map((c) => c.source), batch.map((c) => c.title),
        batch.map((c) => c.text), batch.map((c) => c.cite)],
    ));
  }

  /** Multi-row inserts in one transaction: one round trip per batch instead of per row. */
  private async insertBatches<T>(items: T[], insert: (client: pg.PoolClient, batch: T[]) => Promise<unknown>): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (let i = 0; i < items.length; i += INSERT_BATCH) {
        await insert(client, items.slice(i, i + INSERT_BATCH));
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  async getChunk(id: string): Promise<Chunk | undefined> {
    const r = await this.pool.query(
      `SELECT id, source, title, text, cite FROM ${this.t}_chunks WHERE id = $1`,
      [id],
    );
    return r.rows[0] as Chunk | undefined;
  }

  async ftsSearch(query: string, k: number): Promise<string[]> {
    const tokens = ftsTokens(query);
    if (tokens.length === 0) return [];
    const tsquery = tokens.join(" | ");
    const r = await this.pool.query(
      `SELECT id FROM ${this.t}_chunks
       WHERE tsv @@ to_tsquery('english', $1)
       ORDER BY ts_rank(tsv, to_tsquery('english', $1)) DESC, id
       LIMIT $2`,
      [tsquery, k],
    );
    return r.rows.map((row) => row.id as string);
  }

  async ensureVectorTable(dim: number): Promise<void> {
    if (this.vecReady) return;
    if (!Number.isInteger(dim) || dim <= 0) throw new Error(`vector dim must be positive (got ${dim})`);
    // The HNSW index is built by swapIntoLive, once all vectors are in.
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS ${this.t}_vec (id TEXT PRIMARY KEY, embedding vector(${dim}))`,
    );
    this.vecReady = true;
  }

  async upsertVectors(items: { id: string; vector: number[] }[]): Promise<void> {
    if (!this.vecReady) throw new Error("call ensureVectorTable(dim) before upsertVectors");
    await this.insertBatches(lastById(items), (client, batch) => client.query(
      `INSERT INTO ${this.t}_vec (id, embedding)
       SELECT id, embedding::vector FROM unnest($1::text[], $2::text[]) AS u(id, embedding)
       ON CONFLICT (id) DO UPDATE SET embedding = EXCLUDED.embedding`,
      [batch.map((it) => it.id), batch.map((it) => JSON.stringify(it.vector))],
    ));
  }

  async vectorSearch(vector: number[], k: number): Promise<{ id: string; distance: number }[]> {
    if (!this.vecReady) return [];
    const r = await this.pool.query(
      `SELECT id, embedding <=> $1 AS distance FROM ${this.t}_vec ORDER BY embedding <=> $1 LIMIT $2`,
      [JSON.stringify(vector), k],
    );
    return r.rows.map((row) => ({ id: row.id as string, distance: Number(row.distance) }));
  }

  async isPopulated(): Promise<boolean> {
    const r = await this.pool.query(`SELECT EXISTS (SELECT 1 FROM ${this.t}_chunks) AS e`);
    return r.rows[0].e === true;
  }

  async hasVectors(): Promise<boolean> {
    if (!this.vecReady) return false;
    const r = await this.pool.query(`SELECT EXISTS (SELECT 1 FROM ${this.t}_vec) AS e`);
    return r.rows[0].e === true;
  }

  async setMeta(meta: IndexMeta): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${this.t}_meta (id, json) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET json = $1`,
      [JSON.stringify(meta)],
    );
  }

  async getMeta(): Promise<IndexMeta | undefined> {
    const r = await this.pool.query(`SELECT json FROM ${this.t}_meta WHERE id = 1`);
    if (r.rows.length === 0) return undefined;
    try {
      const v = r.rows[0].json;
      return (typeof v === "string" ? JSON.parse(v) : v) as IndexMeta;
    } catch {
      return undefined;
    }
  }

  async reset(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`TRUNCATE ${this.t}_chunks`);
      await client.query(`DELETE FROM ${this.t}_meta`);
      await client.query(`DROP TABLE IF EXISTS ${this.t}_vec`);
      this.vecReady = false;
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * Build the HNSW index once all vectors are in; a no-op without a vector table or when built.
   * It can run for minutes, so an ingest calls it before re-checking its lock, not after.
   */
  async buildVectorIndex(): Promise<void> {
    const vec = await this.pool.query("SELECT to_regclass($1) AS reg", [`${this.t}_vec`]);
    if (vec.rows[0].reg === null) return;
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS ${this.t}_vec_idx ON ${this.t}_vec USING hnsw (embedding vector_cosine_ops)`,
    );
  }

  async swapIntoLive(): Promise<void> {
    if (!this.isStaging) {
      throw new Error("swapIntoLive can only be called on a staging store");
    }
    // Normally built already (see buildVectorIndex); never inside the swap transaction, which
    // locks the live tables the server keeps reading until the swap.
    await this.buildVectorIndex();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      // The live tables' grants (a serving role's SELECT) would go with them: copy them onto the
      // staging tables first. A first _vec, with no live one before it, takes _chunks' grants.
      const regclass = async (name: string) =>
        (await client.query("SELECT to_regclass($1) AS reg", [name])).rows[0].reg !== null;
      await copyGrants(client, `${this.livePrefix}_chunks`, `${this.t}_chunks`);
      await copyGrants(client, `${this.livePrefix}_meta`, `${this.t}_meta`);
      if (await regclass(`${this.t}_vec`)) {
        const from = (await regclass(`${this.livePrefix}_vec`)) ? `${this.livePrefix}_vec` : `${this.livePrefix}_chunks`;
        await copyGrants(client, from, `${this.t}_vec`);
      }

      // Drop existing live tables
      await client.query(`DROP TABLE IF EXISTS ${this.livePrefix}_chunks`);
      await client.query(`DROP TABLE IF EXISTS ${this.livePrefix}_meta`);
      await client.query(`DROP TABLE IF EXISTS ${this.livePrefix}_vec`);

      // Rename staging tables to live names
      await client.query(`ALTER TABLE ${this.t}_chunks RENAME TO ${this.livePrefix}_chunks`);
      await client.query(`ALTER TABLE ${this.t}_meta RENAME TO ${this.livePrefix}_meta`);

      // Check if vec table exists and rename it if so
      const vecExists = await client.query("SELECT to_regclass($1) AS reg", [`${this.t}_vec`]);
      if (vecExists.rows[0].reg !== null) {
        await client.query(`ALTER TABLE ${this.t}_vec RENAME TO ${this.livePrefix}_vec`);
      }

      // Rename indexes on chunks table
      await client.query(`ALTER INDEX ${this.t}_chunks_tsv RENAME TO ${this.livePrefix}_chunks_tsv`);

      // Rename vec index if the table exists
      if (vecExists.rows[0].reg !== null) {
        await client.query(`ALTER INDEX ${this.t}_vec_idx RENAME TO ${this.livePrefix}_vec_idx`);
      }

      // Rename primary key constraints
      // chunks_pkey
      const chunksPkey = await client.query(
        `SELECT conname FROM pg_constraint WHERE conrelid = $1::regclass AND contype = 'p'`,
        [`${this.livePrefix}_chunks`],
      );
      if (chunksPkey.rows.length > 0) {
        const oldPkeyName = client.escapeIdentifier(chunksPkey.rows[0].conname);
        await client.query(
          `ALTER TABLE ${this.livePrefix}_chunks RENAME CONSTRAINT ${oldPkeyName} TO ${this.livePrefix}_chunks_pkey`,
        );
      }

      // meta_pkey
      const metaPkey = await client.query(
        `SELECT conname FROM pg_constraint WHERE conrelid = $1::regclass AND contype = 'p'`,
        [`${this.livePrefix}_meta`],
      );
      if (metaPkey.rows.length > 0) {
        const oldPkeyName = client.escapeIdentifier(metaPkey.rows[0].conname);
        await client.query(
          `ALTER TABLE ${this.livePrefix}_meta RENAME CONSTRAINT ${oldPkeyName} TO ${this.livePrefix}_meta_pkey`,
        );
      }

      // vec_pkey (if vec table exists)
      if (vecExists.rows[0].reg !== null) {
        const vecPkey = await client.query(
          `SELECT conname FROM pg_constraint WHERE conrelid = $1::regclass AND contype = 'p'`,
          [`${this.livePrefix}_vec`],
        );
        if (vecPkey.rows.length > 0) {
          const oldPkeyName = client.escapeIdentifier(vecPkey.rows[0].conname);
          await client.query(
            `ALTER TABLE ${this.livePrefix}_vec RENAME CONSTRAINT ${oldPkeyName} TO ${this.livePrefix}_vec_pkey`,
          );
        }
      }

      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  async dropTables(): Promise<void> {
    await this.pool.query(`DROP TABLE IF EXISTS ${this.t}_chunks`);
    await this.pool.query(`DROP TABLE IF EXISTS ${this.t}_meta`);
    await this.pool.query(`DROP TABLE IF EXISTS ${this.t}_vec`);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
