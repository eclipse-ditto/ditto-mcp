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

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import YAML from "yaml";
import type { AppConfig } from "../config/schema.js";
import type { ToolDef } from "../core/types.js";
import type { DittoClient } from "./client.js";
import { HttpDittoClient } from "./client.js";
import { parseOperations } from "./openapi.js";
import { isAllowed } from "./tool-policy.js";
import { MAX_TOOL_NAME, operationToTool, type ToolCredentials } from "./action-tool.js";
import { createConfigCredential } from "./credential.js";
import { errorReason } from "../knowledge/ingest-error.js";

export interface ActionToolDeps {
  loadSpec?: () => Promise<unknown>;
  client?: DittoClient;
}

// Ditto OpenAPI spec that `npm run fetch-spec` puts at openapi/ditto-api-2.yml, pinned by
// openapi/ditto-spec.json (see openapi/README.md). Resolves from both src (tsx) and dist (tsc):
// dirname is src/ditto or dist/ditto -> two levels up = the package root, which is /app in the
// Docker image.
export const BUNDLED_SPEC_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..", "..",
  "openapi", "ditto-api-2.yml",
);

// Substitute the literal ${version} placeholder in a version URL template.
export function buildVersionUrl(template: string, version: string): string {
  return template.replaceAll("${version}", version);
}

async function fetchSpec(url: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  } catch (err) {
    // Node's fetch says only "fetch failed"; name the URL so the operator knows what to fix.
    throw new Error(`openapi fetch ${url}: ${errorReason(err)}`);
  }
  if (!res.ok) throw new Error(`openapi fetch ${url} -> ${res.status}`);
  return YAML.parse(await res.text());
}

// YAML.parse also parses JSON, so this handles .yml, .yaml, and .json specs.
async function defaultLoadSpec(config: AppConfig): Promise<unknown> {
  const { path, url, version, versionUrlTemplate } = config.ditto.openApi;
  if (path) return YAML.parse(await readFile(path, "utf8"));
  if (url) return fetchSpec(url);
  if (version) return fetchSpec(buildVersionUrl(versionUrlTemplate, version));
  // Fallback: the Ditto spec vendored in this repo.
  return YAML.parse(await readFile(BUNDLED_SPEC_PATH, "utf8"));
}

export async function makeActionTools(config: AppConfig, deps: ActionToolDeps = {}): Promise<ToolDef[]> {
  const client =
    deps.client ??
    (config.ditto.baseUrl
      ? new HttpDittoClient(config.ditto.baseUrl)
      : undefined);
  // The tools are built once at startup, so fail it rather than serve without them until a
  // restart: an orchestrator then retries, and the cause is in front of the operator.
  if (!client) {
    throw new Error("ditto.enabled is true but ditto.baseUrl is not set");
  }
  let spec: unknown;
  try {
    spec = deps.loadSpec ? await deps.loadSpec() : await defaultLoadSpec(config);
  } catch (err) {
    throw new Error(`cannot build the Ditto action tools: ${errorReason(err)}`, { cause: err });
  }
  const dc = config.ditto.devopsCredential;
  if (dc?.kind === "basic" && dc.username === undefined) {
    process.stderr.write(
      "[ditto-mcp] devopsCredential is 'basic' but has no username; sudo requests will be sent unauthenticated\n",
    );
  }
  const creds: ToolCredentials = {
    standard: createConfigCredential(config.ditto.credential),
    devops: dc ? createConfigCredential(dc) : undefined,
  };
  const tools = parseOperations(spec)
    .filter((op) => isAllowed(op, config.ditto.policy))
    .map((op) => operationToTool(op, client, creds));
  // De-duplicate tool names: on collision, append the first free _2, _3, ... within the length
  // limit. "Free" includes names other tools already hold, or ToolRegistry would throw.
  const taken = new Set<string>();
  for (const tool of tools) {
    let name = tool.name;
    for (let n = 2; taken.has(name); n++) {
      const suffix = `_${n}`;
      name = `${tool.name.slice(0, MAX_TOOL_NAME - suffix.length)}${suffix}`;
    }
    tool.name = name;
    taken.add(name);
  }
  return tools;
}
