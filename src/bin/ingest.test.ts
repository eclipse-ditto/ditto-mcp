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
import { mkdtempSync, writeFileSync, existsSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import { SqliteKnowledgeStore } from "../knowledge/sqlite-knowledge-store.js";
import { docKey } from "../knowledge/chunker.js";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "ingest.ts");

function makeConfig(idxDir: string, paths: string[], publicUrl?: string) {
  const path = join(idxDir, "index.db");
  const cfgPath = join(idxDir, "config.json");
  writeFileSync(cfgPath, JSON.stringify({
    knowledge: {
      retriever: "fts",
      publicSource: publicUrl ? { enabled: true, url: publicUrl } : { enabled: false },
      localDir: { enabled: true, paths },
      store: { kind: "sqlite", sqlite: { path } },
    },
  }));
  return { path, cfgPath };
}

/** A localhost port with nothing listening on it. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}

describe("ingest CLI (spawn e2e)", () => {
  it("builds a persisted fts index from a local dir corpus", async () => {
    const corpus = mkdtempSync(join(tmpdir(), "ditto-corpus-"));
    writeFileSync(join(corpus, "a.md"), "# Reconnect\n\nNetty leak out of memory crash.");
    const idxDir = mkdtempSync(join(tmpdir(), "ditto-idx-"));
    const path = join(idxDir, "index.db");
    const cfgPath = join(idxDir, "config.json");
    writeFileSync(cfgPath, JSON.stringify({
      knowledge: {
        retriever: "fts",
        publicSource: { enabled: false },
        localDir: { enabled: true, paths: [corpus] },
        store: { kind: "sqlite", sqlite: { path } },
      },
    }));

    execFileSync(process.execPath, ["--import", "tsx", entry], {
      env: { ...process.env, DITTO_MCP_CONFIG: cfgPath },
      stdio: "pipe",
    });

    expect(existsSync(path)).toBe(true);
    const store = new SqliteKnowledgeStore(path);
    expect(await store.isPopulated()).toBe(true);
    expect((await store.ftsSearch("memory", 5)).length).toBeGreaterThan(0);
    await store.close();
  }, 30000);

  it("re-ingest is a clean rebuild (no orphan chunks from a larger prior run)", async () => {
    const corpus = mkdtempSync(join(tmpdir(), "ditto-corpus-"));
    const idxDir = mkdtempSync(join(tmpdir(), "ditto-idx-"));
    const path = join(idxDir, "index.db");
    const cfgPath = join(idxDir, "config.json");
    const cfg = (files: number) => {
      // (re)write corpus with `files` docs
      for (let i = 0; i < files; i++) writeFileSync(join(corpus, `d${i}.md`), `# D${i}\n\ndoc ${i} netty`);
      writeFileSync(cfgPath, JSON.stringify({
        knowledge: { retriever: "fts", publicSource: { enabled: false },
          localDir: { enabled: true, paths: [corpus] }, store: { kind: "sqlite", sqlite: { path } } },
      }));
    };
    const run = () => execFileSync(process.execPath, ["--import", "tsx", entry],
      { env: { ...process.env, DITTO_MCP_CONFIG: cfgPath }, stdio: "pipe" });

    cfg(5); run();
    // shrink corpus: remove all, write 1 doc
    for (let i = 0; i < 5; i++) rmSync(join(corpus, `d${i}.md`), { force: true });
    cfg(1); run();

    const store = new SqliteKnowledgeStore(path);
    // Only the single remaining doc's chunk id should exist.
    expect(await store.getChunk(`local:${docKey(join(corpus, "d0.md"))}#0`)).toBeDefined();
    expect(await store.getChunk(`local:${docKey(join(corpus, "d4.md"))}#0`)).toBeUndefined(); // orphan from the 5-doc run is gone
    await store.close();
  }, 30000);

  it("fails without touching the existing index when a configured dir is missing", async () => {
    const corpus = mkdtempSync(join(tmpdir(), "ditto-corpus-"));
    writeFileSync(join(corpus, "a.md"), "# Memory\n\nOut of memory.");
    const idxDir = mkdtempSync(join(tmpdir(), "ditto-idx-"));

    // First run with valid corpus
    const { path, cfgPath } = makeConfig(idxDir, [corpus]);
    const first = spawnSync(process.execPath, ["--import", "tsx", entry], {
      env: { ...process.env, DITTO_MCP_CONFIG: cfgPath },
      encoding: "utf8",
    });
    expect(first.status).toBe(0);

    const indexBytes = readFileSync(path);

    // Second run with missing dir
    const missing = join(idxDir, "missing");
    const cfg2 = makeConfig(idxDir, [corpus, missing]);
    const second = spawnSync(process.execPath, ["--import", "tsx", entry], {
      env: { ...process.env, DITTO_MCP_CONFIG: cfg2.cfgPath },
      encoding: "utf8",
    });

    expect(second.status).toBe(1);
    expect(second.stderr).toContain(missing);
    expect(second.stderr).toContain("--force");
    expect(second.stderr).not.toMatch(/\n\s+at /); // no stack trace

    // Index unchanged
    const indexBytesAfter = readFileSync(path);
    expect(indexBytes.equals(indexBytesAfter)).toBe(true);
  }, 30000);

  it("--force builds without the missing dir", async () => {
    const corpus = mkdtempSync(join(tmpdir(), "ditto-corpus-"));
    writeFileSync(join(corpus, "a.md"), "# Memory\n\nOut of memory.");
    const idxDir = mkdtempSync(join(tmpdir(), "ditto-idx-"));
    const missing = join(idxDir, "missing");

    const { path, cfgPath } = makeConfig(idxDir, [corpus, missing]);
    const result = spawnSync(process.execPath, ["--import", "tsx", entry, "--force"], {
      env: { ...process.env, DITTO_MCP_CONFIG: cfgPath },
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain(`skipped local: ${missing}`);

    const store = new SqliteKnowledgeStore(path);
    expect(await store.isPopulated()).toBe(true);
    expect((await store.ftsSearch("memory", 5)).length).toBeGreaterThan(0);
    await store.close();
  }, 30000);

  it("--force still fails when a source fails entirely", async () => {
    const corpus = mkdtempSync(join(tmpdir(), "ditto-corpus-"));
    writeFileSync(join(corpus, "a.md"), "# Memory\n\nOut of memory.");
    const idxDir = mkdtempSync(join(tmpdir(), "ditto-idx-"));

    // First run to establish index
    const { path, cfgPath: cfgPath1 } = makeConfig(idxDir, [corpus]);
    const first = spawnSync(process.execPath, ["--import", "tsx", entry], {
      env: { ...process.env, DITTO_MCP_CONFIG: cfgPath1 },
      encoding: "utf8",
    });
    expect(first.status).toBe(0);

    const indexBytes = readFileSync(path);

    // Second run with unreachable public source
    const url = `http://127.0.0.1:${await closedPort()}/llms.txt`;
    const { cfgPath } = makeConfig(idxDir, [corpus], url);
    const second = spawnSync(process.execPath, ["--import", "tsx", entry, "--force"], {
      env: { ...process.env, DITTO_MCP_CONFIG: cfgPath },
      encoding: "utf8",
    });

    expect(second.status).toBe(1);
    expect(second.stderr).toContain(`public: cannot fetch ${url}: fetch failed: ECONNREFUSED`);

    // Index unchanged
    const indexBytesAfter = readFileSync(path);
    expect(indexBytes.equals(indexBytesAfter)).toBe(true);
  }, 30000);
});
