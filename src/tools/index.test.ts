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
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerTools } from "./index.js";
import { AppConfigSchema } from "../config/schema.js";
import { KnowledgeService } from "../knowledge/knowledge-service.js";
import { SqliteKnowledgeStore } from "../knowledge/sqlite-knowledge-store.js";
import { FtsRetriever } from "../knowledge/fts-retriever.js";
import type { Chunk } from "../knowledge/types.js";

const chunk = (id: string, text: string): Chunk => ({
  id,
  source: "test",
  title: "T",
  text,
  cite: `https://x/${id}`,
});

let store: SqliteKnowledgeStore | undefined;
afterEach(() => store?.close());

describe("registerTools wiring", () => {
  it("registers ping by default", async () => {
    const reg = await registerTools(
      AppConfigSchema.parse({ knowledge: { enabled: false } }),
    );
    expect(reg.get("ping")).toBeDefined();
  });

  it("omits action tools when ditto disabled (default)", async () => {
    const reg = await registerTools(AppConfigSchema.parse({}));
    expect(reg.list().some((t) => t.name.startsWith("ditto_"))).toBe(false);
  });

  it("omits knowledge tools when knowledge disabled", async () => {
    const reg = await registerTools(
      AppConfigSchema.parse({ knowledge: { enabled: false } }),
    );
    expect(reg.get("search")).toBeUndefined();
    expect(reg.get("get_chunk")).toBeUndefined();
  });

  it("omits knowledge tools when service not provided", async () => {
    const reg = await registerTools(
      AppConfigSchema.parse({ knowledge: { enabled: true } }),
    );
    expect(reg.get("search")).toBeUndefined();
    expect(reg.get("get_chunk")).toBeUndefined();
  });

  it("registers an action tool named like a built-in beside it, under the ditto_ prefix", async () => {
    // A custom spec may declare operationIds such as "search"; that must not crash startup.
    const specPath = join(mkdtempSync(join(tmpdir(), "mcp-tools-")), "spec.json");
    writeFileSync(specPath, JSON.stringify({ paths: {
      "/search": { get: { operationId: "search" } },
      "/ping": { get: { operationId: "ping" } },
    } }));
    store = new SqliteKnowledgeStore(":memory:");
    const service = new KnowledgeService(store, new FtsRetriever(store));
    const reg = await registerTools(
      AppConfigSchema.parse({
        knowledge: { enabled: true },
        ditto: { enabled: true, baseUrl: "http://ditto", openApi: { path: specPath } },
      }),
      service,
    );
    expect(reg.list().map((t) => t.name).sort()).toEqual(["ditto_ping", "ditto_search", "get_chunk", "ping", "search"]);
  });

  it("registers knowledge tools when enabled and service provided", async () => {
    store = new SqliteKnowledgeStore(":memory:");
    await store.addChunks([chunk("a", "test content")]);
    const retriever = new FtsRetriever(store);
    const service = new KnowledgeService(store, retriever);
    const reg = await registerTools(
      AppConfigSchema.parse({ knowledge: { enabled: true } }),
      service,
    );
    expect(reg.get("ping")).toBeDefined();
    expect(reg.get("search")).toBeDefined();
    expect(reg.get("get_chunk")).toBeDefined();
  });
});
