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

// Puts Ditto's OpenAPI spec at openapi/ditto-api-2.yml, the offline fallback for the action
// tools. The Ditto git ref and the file's sha256 are pinned in openapi/ditto-spec.json, so every
// checkout and image gets the same bytes. Runs before test, build and dev: a file that already
// matches the pin is left alone and nothing is fetched, which also lets an offline machine use a
// copy placed there by hand.

import { createHash } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";

const dir = new URL("../openapi/", import.meta.url);
const target = new URL("ditto-api-2.yml", dir);
const { ref, sha256 } = JSON.parse(await readFile(new URL("ditto-spec.json", dir), "utf8"));
const url = `https://raw.githubusercontent.com/eclipse-ditto/ditto/${ref}/documentation/src/main/resources/openapi/ditto-api-2.yml`;

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

function fail(message) {
  process.stderr.write(`[ditto-mcp fetch-spec] ${message}\n`);
  process.exit(1);
}

const existing = await readFile(target).catch(() => undefined);
if (existing && hash(existing) === sha256) process.exit(0);

let res;
try {
  res = await fetch(url, { signal: AbortSignal.timeout(30000) });
} catch (err) {
  // Node's fetch says only "fetch failed"; the cause holds ENOTFOUND, ECONNREFUSED, TLS errors.
  fail(`${url}: ${err.message}${err.cause ? `: ${err.cause.code ?? err.cause.message}` : ""}`);
}
if (!res.ok) fail(`${url} -> ${res.status}`);
const bytes = Buffer.from(await res.arrayBuffer());
const actual = hash(bytes);
// A moved tag or a tampered download must not become the spec the tools are generated from.
if (actual !== sha256) fail(`${url}: sha256 is ${actual}, but openapi/ditto-spec.json pins ${sha256}`);

const tmp = new URL(`ditto-api-2.yml.tmp-${process.pid}`, dir);
try {
  await writeFile(tmp, bytes);
  await rename(tmp, target);
} finally {
  await rm(tmp, { force: true });
}
process.stderr.write(`[ditto-mcp fetch-spec] ${url} -> openapi/ditto-api-2.yml\n`);
