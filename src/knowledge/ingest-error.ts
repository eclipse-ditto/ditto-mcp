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

import type { SkippedItem } from "./types.js";

/**
 * An ingest refused to write for a reason the operator can act on; nothing was written.
 */
export class IngestError extends Error {
  readonly name = "IngestError";
  readonly skipped: SkippedItem[];

  constructor(message: string, opts?: { skipped?: SkippedItem[]; cause?: unknown }) {
    super(message, { cause: opts?.cause });
    this.skipped = opts?.skipped ?? [];
  }
}

/**
 * An error's message plus its cause's code or message: Node's fetch says only "fetch failed"
 * and puts ECONNREFUSED, ENOTFOUND or the TLS error in `cause`.
 */
export function errorReason(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause as { code?: unknown; message?: unknown } | undefined;
  const detail = typeof cause === "object" && cause !== null ? (cause.code ?? cause.message) : undefined;
  return detail ? `${err.message}: ${String(detail)}` : err.message;
}
