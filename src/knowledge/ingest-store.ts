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

import { renameSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type { AppConfig } from "../config/schema.js";
import type { KnowledgeStore } from "./knowledge-store.js";
import { openStore, importPgStore } from "./store-factory.js";

export async function withIngestStore(
  config: AppConfig,
  fn: (store: KnowledgeStore) => Promise<void>,
): Promise<void> {
  const kind = config.knowledge.store.kind;
  if (kind === "sqlite") {
    const path = config.knowledge.store.sqlite.path;
    if (!path) throw new Error("knowledge.store.sqlite.path is required for ingest");
    const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
    const store = await openStore(config, { path: tmp });
    try {
      await fn(store);
      await store.close();
    } catch (err) {
      await store.close();
      rmSync(tmp, { force: true });
      throw err;
    }
    renameSync(tmp, path);
    return;
  }
  if (kind === "pgvector") {
    const { connectionString, table } = config.knowledge.store.pgvector;
    if (!connectionString) throw new Error("knowledge.store.pgvector.connectionString is required");
    const PgKnowledgeStore = await importPgStore();
    const lock = await PgKnowledgeStore.lockIngest(connectionString, table);
    try {
      const staging = await PgKnowledgeStore.connect(connectionString, table, { staging: true });
      try {
        await staging.reset();
        await fn(staging);
        await staging.buildVectorIndex();
        // If the lock session died, another ingest may have written to the staging tables.
        // Checked after the (possibly long) index build, right before the swap.
        await lock.assertHeld();
        await staging.swapIntoLive();
      } catch (err) {
        // Without the lock the staging tables may belong to another ingest: leave them.
        const held = await lock.assertHeld().then(() => true, () => false);
        if (held) await staging.dropTables().catch(() => {}); // ignore error from dropTables
        throw err;
      } finally {
        await staging.close();
      }
    } finally {
      await lock.release();
    }
    return;
  }
  throw new Error(`unsupported store kind for ingest: ${kind}`);
}
