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

import { readdirSync, readFileSync } from "node:fs";
import { join, basename, extname } from "node:path";
import type { Chunk, KnowledgeSource, SkipFn } from "./types.js";
import { chunkMarkdown } from "./chunker.js";
import { errorReason } from "./ingest-error.js";

export interface LocalDirSourceOptions {
  dirs: string[];
  id?: string;
  chunkOptions?: { maxChars?: number; overlap?: number };
}

const MD_EXT = new Set([".md", ".markdown"]);

export class LocalDirSource implements KnowledgeSource {
  readonly id: string;
  private readonly opts: LocalDirSourceOptions;

  constructor(opts: LocalDirSourceOptions) {
    this.opts = opts;
    this.id = opts.id ?? "local";
  }

  async loadChunks(_signal?: AbortSignal, onSkip?: SkipFn): Promise<Chunk[]> {
    const allFiles: string[] = [];
    for (const dir of this.opts.dirs) {
      try {
        const dirFiles = walk(dir);
        if (dirFiles.length === 0) {
          onSkip?.(dir, "no markdown files");
        } else {
          allFiles.push(...dirFiles);
        }
      } catch (err) {
        onSkip?.(dir, errorReason(err));
      }
    }
    // De-duplicate files: first-seen order (overlapping paths should not re-process a file).
    const files: string[] = [];
    const seen = new Set<string>();
    for (const file of allFiles) {
      if (!seen.has(file)) {
        seen.add(file);
        files.push(file);
      }
    }
    const chunks: Chunk[] = [];
    for (const file of files) {
      try {
        const md = readFileSync(file, "utf8");
        chunks.push(
          ...chunkMarkdown(md, {
            source: this.id,
            title: basename(file),
            cite: file,
            maxChars: this.opts.chunkOptions?.maxChars,
            overlap: this.opts.chunkOptions?.overlap,
          }),
        );
      } catch (err) {
        onSkip?.(file, errorReason(err));
      }
    }
    return chunks;
  }
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (MD_EXT.has(extname(entry.name).toLowerCase())) out.push(full);
  }
  return out.sort(); // deterministic order
}
