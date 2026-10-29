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

import { createHash } from "node:crypto";
import { z, type ZodRawShape } from "zod";
import { textResult, type ToolDef, type ToolResult, type RequestCtx } from "../core/types.js";
import { MERGE_PATCH, mediaType, type DittoOperation } from "./openapi.js";
import type { DittoClient } from "./client.js";
import type { DittoCredential } from "./credential.js";
import { isSudo } from "./tool-policy.js";

// Clients commonly enforce tool names of [A-Za-z0-9_-]{1,64}.
export const MAX_TOOL_NAME = 64;

// Replace illegal chars, collapse runs of "_", and trim the edges.
function sanitize(id: string): string {
  return id
    .replace(/[^A-Za-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

// "/api/2/things/{thingId}/features/{featureId}" -> "things_features_featureId": the version
// prefix is noise and an inner parameter is implied by the collection before it, so only a
// trailing one is kept. That keeps every bundled name readable and under the limit.
function shortPath(path: string): string {
  const segments = path.replace(/^\/api\/2(?=\/|$)/, "").split("/").filter(Boolean);
  return segments.filter((s, i) => !s.startsWith("{") || i === segments.length - 1).join("_");
}

// Every action tool is prefixed "ditto_", so no spec operation can shadow a built-in tool
// (search, get_chunk, ping). Ditto's spec declares no operationIds; for those, parseOperations
// synthesizes "<METHOD>_<path>" and the name is built from method and shortened path instead.
export function toolName(op: DittoOperation): string {
  const synthesized = op.operationId === `${op.method}_${op.path}`;
  const name = `ditto_${sanitize(synthesized ? `${op.method}_${shortPath(op.path)}` : op.operationId)}`;
  if (name.length <= MAX_TOOL_NAME) return name;
  // Swap the tail for a hash of the operation, so two operations sharing a long prefix stay distinct.
  const hash = createHash("sha256").update(`${op.method} ${op.path}`).digest("hex").slice(0, 8);
  return `${name.slice(0, MAX_TOOL_NAME - hash.length - 1).replace(/_+$/, "")}_${hash}`;
}

function inputSchema(op: DittoOperation): ZodRawShape {
  const shape: ZodRawShape = {};
  for (const p of op.params) {
    const base = p.type === "number" ? z.number() : p.type === "boolean" ? z.boolean() : z.string();
    shape[p.name] = (p.required ? base : base.optional()).describe(`${p.in} parameter ${p.name}`);
  }
  if (op.bodySchema?.props.length) {
    const bodyShape: ZodRawShape = {};
    // In a merge patch, null deletes the field.
    const nullable = op.contentType !== undefined && mediaType(op.contentType) === MERGE_PATCH;
    for (const bp of op.bodySchema.props) {
      const base = bp.type === "number" ? z.number()
        : bp.type === "boolean" ? z.boolean()
        : bp.type === "object" ? z.record(z.any())
        : bp.type === "array" ? z.array(z.any())
        : bp.type === "unknown" ? z.any()
        : z.string();
      const desc = `body.${bp.name}` + (bp.required ? " (required)" : "") + (nullable ? " (null deletes it)" : "");
      bodyShape[bp.name] = (nullable ? base.nullable() : base).optional().describe(desc);
    }
    shape.body = z.object(bodyShape).passthrough().optional().describe("JSON request body");
  } else if (op.hasBody) {
    shape.body = z.any().optional().describe("JSON request body");
  }
  return shape;
}

export interface ToolCredentials {
  standard: DittoCredential;
  devops?: DittoCredential;
}

export function operationToTool(op: DittoOperation, client: DittoClient, creds: ToolCredentials): ToolDef {
  const sudo = isSudo(op);
  return {
    name: toolName(op),
    description:
      `${op.method} ${op.path} — ${op.description || op.summary}` +
      (sudo ? " [sudo — requires a devops credential]" : ""),
    inputSchema: inputSchema(op),
    handler: async (args: unknown, ctx: RequestCtx): Promise<ToolResult> => {
      // Non-sudo ops always have `standard`; sudo ops require the `devops` slot.
      const base = sudo ? creds.devops : creds.standard;
      if (!base) {
        return textResult(`Refused: "${op.operationId}" is a sudo operation and requires ditto.devopsCredential.`);
      }
      // The server calls Ditto only as itself: caller headers never select or replace the credential.
      const res = await client.execute(op, (args ?? {}) as Record<string, unknown>, base, ctx.signal);
      return textResult(`HTTP ${res.status}\n${res.body}`);
    },
  };
}
