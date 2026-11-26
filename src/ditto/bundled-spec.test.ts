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
import { readFileSync } from "node:fs";
import YAML from "yaml";
import { parseOperations } from "./openapi.js";
import { isSudo } from "./tool-policy.js";
import { BUNDLED_SPEC_PATH as specPath } from "./action-tools.js";
import { operationToTool } from "./action-tool.js";
import { HttpDittoClient } from "./client.js";

describe("bundled Ditto spec", () => {
  it("parses and yields operations incl. a things GET with a resolved path param", () => {
    const spec = YAML.parse(readFileSync(specPath, "utf8"));
    const ops = parseOperations(spec);
    expect(ops.length).toBeGreaterThan(20);
    const getThing = ops.find((o) => o.method === "GET" && o.path.includes("/things/{thingId}"));
    expect(getThing).toBeDefined();
    expect(getThing!.params.some((p) => p.name === "thingId" && p.in === "path")).toBe(true);
  });

  it("classifies /api/2/connections GET as isSudo (DevOpsBasic security)", () => {
    const spec = YAML.parse(readFileSync(specPath, "utf8"));
    const ops = parseOperations(spec);
    const getConnections = ops.find((o) => o.method === "GET" && o.path.startsWith("/api/2/connections"));
    expect(getConnections).toBeDefined();
    expect(isSudo(getConnections!)).toBe(true);
  });

  it("resolves bodySchema for PUT /api/2/things/{thingId}", () => {
    const spec = YAML.parse(readFileSync(specPath, "utf8"));
    const ops = parseOperations(spec);
    const putThing = ops.find((o) => o.method === "PUT" && o.path === "/api/2/things/{thingId}");
    expect(putThing).toBeDefined();
    expect(putThing!.hasBody).toBe(true);
    // The NewThing schema is an object with properties, so bodySchema should be defined
    expect(putThing!.bodySchema).toBeDefined();
    expect(putThing!.bodySchema!.props.length).toBeGreaterThan(0);
    // Verify some expected properties are present (policyId, definition, attributes, features, _policy, _copyPolicyFrom)
    const propNames = putThing!.bodySchema!.props.map(p => p.name);
    expect(propNames).toContain("policyId");
  });

  it("sends every PATCH as merge-patch, which is the only type Ditto's PATCH routes accept", () => {
    const spec = YAML.parse(readFileSync(specPath, "utf8"));
    const patches = parseOperations(spec).filter((o) => o.method === "PATCH");
    expect(patches.length).toBeGreaterThan(0);
    for (const op of patches) expect(op.contentType, op.path).toBe("application/merge-patch+json");
    const patchThing = patches.find((o) => o.path === "/api/2/things/{thingId}");
    expect(patchThing!.bodySchema!.props.map((p) => p.name)).toContain("attributes");
  });

  it("gives every bundled operation a distinct tool name of at most 64 chars", () => {
    const ops = parseOperations(YAML.parse(readFileSync(specPath, "utf8")));
    const client = new HttpDittoClient("http://ditto");
    const names = ops.map((op) => operationToTool(op, client, { standard: { authHeader: async () => undefined } }).name);
    expect(new Set(names).size).toBe(ops.length);
    expect(names.filter((n) => n.length > 64)).toEqual([]);
  });

  it("sends a '/' literally only in the entity-path params, each the last segment of its route", async () => {
    // A "/" sent literally in any other param ("ns:a/attributes" as a thingId) would retarget
    // the request to an operation the policy may not expose.
    const ops = parseOperations(YAML.parse(readFileSync(specPath, "utf8")));
    let url = "";
    const fetchFn = (async (u: string | URL | Request) => { url = String(u); return new Response(""); }) as typeof fetch;
    const client = new HttpDittoClient("http://ditto", { fetchFn });
    const literal = new Set<string>();
    for (const op of ops) {
      const pathParams = op.params.filter((p) => p.in === "path");
      for (const p of pathParams) {
        const args = Object.fromEntries(pathParams.map((q) => [q.name, q === p ? "x/y" : "v"]));
        await client.execute(op, args, { authHeader: async () => undefined });
        if (url.includes("x/y")) {
          literal.add(p.name);
          expect(op.path.endsWith(`{${p.name}}`), op.path).toBe(true);
        }
      }
    }
    expect([...literal].sort()).toEqual(["attributePath", "propertyPath", "resourcePath"]);
  });

  it("exposes the CloudEvents ce-* headers Ditto requires as parameters of POST /api/2/cloudevents", () => {
    const ops = parseOperations(YAML.parse(readFileSync(specPath, "utf8")));
    const ce = ops.find((o) => o.method === "POST" && o.path === "/api/2/cloudevents");
    const headers = ce!.params.filter((p) => p.in === "header" && p.required).map((p) => p.name).sort();
    expect(headers).toEqual(expect.arrayContaining(["ce-id", "ce-source", "ce-specversion", "ce-type"]));
  });

  it("sends a search POST form-encoded", () => {
    const spec = YAML.parse(readFileSync(specPath, "utf8"));
    const search = parseOperations(spec).find((o) => o.method === "POST" && o.path === "/api/2/search/things");
    expect(search!.contentType).toBe("application/x-www-form-urlencoded");
  });
});
