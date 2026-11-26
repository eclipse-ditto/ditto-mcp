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

import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalDirSource } from "./local-dir-source.js";
import type { Chunk } from "./types.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ditto-corpus-"));
  writeFileSync(join(dir, "runbook.md"), "# Runbook\n\nRestart connectivity to clear the reconnect storm.");
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "sub", "tuning.markdown"), "# Tuning\n\nDisable Netty leak detection.");
  writeFileSync(join(dir, "ignore.txt"), "not markdown");
});

describe("LocalDirSource", () => {
  it("loads and chunks markdown files recursively, ignoring non-markdown", async () => {
    const src = new LocalDirSource({ dirs: [dir] });
    const chunks = await src.loadChunks();
    expect(src.id).toBe("local");
    const texts = chunks.map((c) => c.text).join("\n");
    expect(texts).toContain("reconnect storm");
    expect(texts).toContain("Netty leak detection");
    expect(texts).not.toContain("not markdown");
    expect(chunks.every((c) => c.source === "local")).toBe(true);
    expect(chunks.every((c) => c.id.startsWith("local:"))).toBe(true);
  });

  it("merges markdown across multiple dirs with unique sequential ids", async () => {
    const dir2 = mkdtempSync(join(tmpdir(), "ditto-corpus2-"));
    writeFileSync(join(dir2, "extra.md"), "# Extra\n\nSecond corpus entry about sharding.");
    const src = new LocalDirSource({ dirs: [dir, dir2] });
    const chunks = await src.loadChunks();
    const texts = chunks.map((c) => c.text).join("\n");
    expect(texts).toContain("reconnect storm");
    expect(texts).toContain("Netty leak detection");
    expect(texts).toContain("sharding");
    // ids stay unique across both dirs
    expect(chunks.every((c) => c.id.startsWith("local:"))).toBe(true);
    expect(new Set(chunks.map((c) => c.id)).size).toBe(chunks.length);
  });

  it("reports a missing dir and still loads the readable ones", async () => {
    const skipped: Array<[string, string]> = [];
    const missing = join(dir, "does-not-exist");
    const src = new LocalDirSource({ dirs: [missing, dir] });
    const chunks = await src.loadChunks(undefined, (item, reason) => {
      skipped.push([item, reason]);
    });
    expect(skipped.length).toBe(1);
    expect(skipped[0][0]).toBe(missing);
    expect(skipped[0][1]).toMatch(/ENOENT/);
    const texts = chunks.map((c) => c.text).join("\n");
    expect(texts).toContain("reconnect storm");
  });

  it("reports a dir with no markdown files", async () => {
    const skipped: Array<[string, string]> = [];
    const emptyDir = mkdtempSync(join(tmpdir(), "ditto-empty-"));
    const src = new LocalDirSource({ dirs: [emptyDir, dir] });
    const chunks = await src.loadChunks(undefined, (item, reason) => {
      skipped.push([item, reason]);
    });
    expect(skipped).toEqual([[emptyDir, "no markdown files"]]);
    const texts = chunks.map((c) => c.text).join("\n");
    expect(texts).toContain("reconnect storm");
  });

  it("reports an unreadable file and keeps loading the rest", async () => {
    const skipped: Array<[string, string]> = [];
    const { symlinkSync } = await import("node:fs");
    const testDir = mkdtempSync(join(tmpdir(), "ditto-dangling-"));
    writeFileSync(join(testDir, "runbook.md"), "# Runbook\n\nRestart connectivity to clear the reconnect storm.");
    const dangling = join(testDir, "dangling.md");
    symlinkSync(join(testDir, "nowhere"), dangling);
    const src = new LocalDirSource({ dirs: [testDir] });
    const chunks = await src.loadChunks(undefined, (item, reason) => {
      skipped.push([item, reason]);
    });
    expect(skipped.length).toBe(1);
    expect(skipped[0][0]).toBe(dangling);
    expect(skipped[0][1]).toMatch(/ENOENT/);
    const texts = chunks.map((c) => c.text).join("\n");
    expect(texts).toContain("reconnect storm");
  });

  it("indexes a file reached through overlapping paths once", async () => {
    const src = new LocalDirSource({ dirs: [dir, join(dir, "sub")] });
    const chunks = await src.loadChunks();
    const tuningChunks = chunks.filter((c) => c.cite === join(dir, "sub", "tuning.markdown"));
    expect(tuningChunks.length).toBe(1);
    expect(new Set(chunks.map((c) => c.id)).size).toBe(chunks.length);
  });

  it("returns [] when all dirs are missing (non-fatal)", async () => {
    const src = new LocalDirSource({ dirs: [join(dir, "does-not-exist")] });
    expect(await src.loadChunks()).toEqual([]);
  });

  it("returns [] for an empty dirs list", async () => {
    const src = new LocalDirSource({ dirs: [] });
    expect(await src.loadChunks()).toEqual([]);
  });

  it("ids of an unchanged document survive an edit to another document", async () => {
    const load = () => new LocalDirSource({ dirs: [dir], chunkOptions: { maxChars: 40, overlap: 0 } }).loadChunks();
    const before = await load();
    writeFileSync(join(dir, "runbook.md"), "# Runbook\n\nA brand new opening paragraph.\n\nRestart connectivity to clear the reconnect storm.");
    const after = await load();
    const ids = (cs: Chunk[]) => cs.filter((c) => c.cite.endsWith("tuning.markdown")).map((c) => c.id);
    expect(ids(after)).toEqual(ids(before));
    expect(ids(before).length).toBeGreaterThan(0);
  });
});
