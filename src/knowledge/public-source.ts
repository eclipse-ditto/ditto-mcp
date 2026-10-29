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

import type { Chunk, KnowledgeSource, SkipFn } from "./types.js";
import { chunkMarkdown } from "./chunker.js";
import { errorReason } from "./ingest-error.js";

export type FetchFn = (url: string, signal?: AbortSignal) => Promise<string>;

export interface PublicSourceOptions {
  url: string;
  fetchFn?: FetchFn;
  maxDocs?: number;
  chunkOptions?: { maxChars?: number; overlap?: number };
}

interface Entry {
  title: string;
  url: string;
}

const defaultFetch: FetchFn = async (url, signal) => {
  const timeout = AbortSignal.timeout(15000);
  const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const res = await fetch(url, { signal: sig });
  if (!res.ok) throw new Error(`fetch ${url} -> ${res.status}`);
  const text = await res.text();
  if (text.length > 5_000_000) {
    throw new Error(`fetch ${url} -> response too large (${text.length} bytes)`);
  }
  return text;
};

export class PublicSource implements KnowledgeSource {
  readonly id = "public";
  private readonly opts: PublicSourceOptions;
  private readonly fetchFn: FetchFn;

  constructor(opts: PublicSourceOptions) {
    this.opts = opts;
    this.fetchFn = opts.fetchFn ?? defaultFetch;
  }

  async loadChunks(signal?: AbortSignal, onSkip?: SkipFn): Promise<Chunk[]> {
    let index: string;
    try {
      index = await this.fetchFn(this.opts.url, signal);
    } catch (err) {
      throw new Error(`cannot fetch ${this.opts.url}: ${errorReason(err)}`);
    }
    let entries = parseEntries(index, this.opts.url);
    if (this.opts.maxDocs !== undefined) {
      entries = entries.slice(0, this.opts.maxDocs);
    }
    // Fetch documents with bounded concurrency (network-bound; sequential
    // fetches make server startup block for a long time on large corpora).
    // Order is preserved for deterministic chunk ordering across runs.
    const CONCURRENCY = 8;
    const perEntry: Chunk[][] = new Array(entries.length);
    for (let i = 0; i < entries.length; i += CONCURRENCY) {
      const batch = entries.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (entry) => {
          let md: string;
          try {
            md = await this.fetchFn(entry.url, signal);
          } catch (err) {
            onSkip?.(entry.url, errorReason(err));
            return [];
          }
          return chunkMarkdown(md, {
            source: this.id,
            title: entry.title,
            cite: entry.url,
            maxChars: this.opts.chunkOptions?.maxChars,
            overlap: this.opts.chunkOptions?.overlap,
          });
        }),
      );
      results.forEach((r, j) => (perEntry[i + j] = r));
    }
    return perEntry.flat();
  }
}

function parseEntries(index: string, baseUrl: string): Entry[] {
  const re = /- \[([^\]]+)\]\(([^)]+)\)/g;
  const entries: Entry[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(index)) !== null) {
    const title = m[1].trim();
    const link = m[2].trim();
    let resolved: URL;
    try {
      resolved = new URL(link, baseUrl);
    } catch (err) {
      // A malformed link is the index's problem and does not heal on re-run, so it is filtered
      // like a non-markdown link (with a warning), not reported as an item that failed to load.
      process.stderr.write(`[ditto-mcp] knowledge: ignoring malformed link in ${baseUrl}: ${link} (${errorReason(err)})\n`);
      continue;
    }
    // Guard against SSRF: only allow http/https schemes
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
      continue;
    }
    // Only ingest markdown docs; llms.txt indexes also link to HTML pages
    // (repo, openapi/jsonschema UIs) that would pollute the corpus with markup.
    const path = resolved.pathname.toLowerCase();
    if (!path.endsWith(".md") && !path.endsWith(".markdown")) {
      continue;
    }
    const url = resolved.toString();
    // De-duplicate: first wins (stable chunk ids across runs even when a doc is listed twice).
    if (seen.has(url)) continue;
    seen.add(url);
    entries.push({ title, url });
  }
  if (entries.length === 0) {
    throw new Error(`no markdown links found in ${baseUrl}; is it an llms.txt?`);
  }
  return entries;
}
