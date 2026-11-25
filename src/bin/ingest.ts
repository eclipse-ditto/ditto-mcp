#!/usr/bin/env node
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

import { loadConfig } from "../config/load.js";
import { buildIndex, metaFor } from "../knowledge/build-index.js";
import { makeSources, makeEmbedder } from "../knowledge/factories.js";
import { withIngestStore } from "../knowledge/ingest-store.js";
import { IngestError } from "../knowledge/ingest-error.js";
import type { EmbeddingProvider } from "../knowledge/embedding.js";

/**
 * In a container node runs as PID 1, which gets no default action for signals: without this,
 * `docker stop` or a deleted Kubernetes Job waits out the grace period and SIGKILLs the ingest,
 * leaving its *.tmp file or staging tables behind. The first signal stops the build, which then
 * cleans up as for any failure; a second one exits at once.
 */
function stopOnSignals(): AbortSignal {
  const stop = new AbortController();
  const onSignal = (signal: NodeJS.Signals): void => {
    if (stop.signal.aborted) {
      process.stderr.write(`[ditto-mcp ingest] ${signal} again; exiting without cleanup\n`);
      process.exit(1);
    }
    process.stderr.write(`[ditto-mcp ingest] ${signal} received; stopping\n`);
    stop.abort(new IngestError(`stopped by ${signal}`));
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  return stop.signal;
}

async function main(): Promise<void> {
  const signal = stopOnSignals();
  const config = loadConfig(process.env.DITTO_MCP_CONFIG);
  if (!config.knowledge.enabled) throw new Error("knowledge is disabled in config");

  const sources = makeSources(config);
  if (sources.length === 0) throw new Error("no knowledge sources enabled");

  let embedder: EmbeddingProvider | undefined;
  if (config.knowledge.retriever !== "fts") {
    embedder = await makeEmbedder(config);
  }

  const force = process.argv.slice(2).includes("--force");

  let chunks = 0;
  let skippedCount = 0;
  signal.throwIfAborted();
  await withIngestStore(config, async (store) => {
    const report = await buildIndex(sources, store, embedder, metaFor(config, embedder), { allowSkipped: force, signal });
    chunks = report.chunks;
    // Print skipped items when --force is used
    if (report.skipped.length > 0) {
      for (const item of report.skipped) {
        process.stderr.write(`[ditto-mcp ingest] skipped ${item.source}: ${item.item}: ${item.reason}\n`);
      }
      skippedCount = report.skipped.length;
    }
  }, signal);

  if (skippedCount > 0) {
    process.stderr.write(`[ditto-mcp ingest] built without ${skippedCount} item(s) that failed to load (--force)\n`);
  }

  const dest = config.knowledge.store.kind === "sqlite" ? config.knowledge.store.sqlite.path : config.knowledge.store.kind;
  process.stderr.write(`[ditto-mcp ingest] done: ${dest} (${chunks} chunks)\n`);
}

main().catch((err) => {
  if (err instanceof IngestError) {
    process.stderr.write(`[ditto-mcp ingest] ${err.message}\n`);
    process.stderr.write(`[ditto-mcp ingest] the existing index was left unchanged`);
    if (err.skipped.length > 0) {
      process.stderr.write(`; re-run, or pass --force to build without them`);
    }
    process.stderr.write(`\n`);
    process.exit(1);
  }
  process.stderr.write(`[ditto-mcp ingest] fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
