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
import { parseOperations } from "./openapi.js";

// Mirrors Ditto's real shape: a $ref'd component parameter + a path-item-level parameter.
const SPEC = {
  components: {
    parameters: {
      ThingIdPathParam: { name: "thingId", in: "path", required: true, schema: { type: "string" } },
    },
  },
  paths: {
    "/things/{thingId}": {
      parameters: [{ $ref: "#/components/parameters/ThingIdPathParam" }], // path-item level, shared
      get: {
        operationId: "getThingById",
        summary: "Retrieve a thing",
        parameters: [{ name: "fields", in: "query", required: false, schema: { type: "string" } }],
      },
      put: {
        operationId: "putThing",
        summary: "Create or update a thing",
        requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/NewThing" } } } },
      },
    },
    "/search/things": {
      get: {
        operationId: "searchThings",
        summary: "Search things",
        parameters: [{ name: "filter", in: "query", required: false, schema: { type: "string" } }],
      },
    },
  },
};

describe("parseOperations", () => {
  it("merges path-item params, resolves $ref params, extracts body existence", () => {
    const ops = parseOperations(SPEC);
    const get = ops.find((o) => o.operationId === "getThingById")!;
    expect(get.method).toBe("GET");
    expect(get.path).toBe("/things/{thingId}");
    // path-item $ref param (thingId) merged with op-level query param (fields):
    expect(get.params).toContainEqual({ name: "thingId", in: "path", required: true, type: "string" });
    expect(get.params).toContainEqual({ name: "fields", in: "query", required: false, type: "string" });
    expect(get.hasBody).toBe(false);

    const put = ops.find((o) => o.operationId === "putThing")!;
    expect(put.method).toBe("PUT");
    expect(put.params).toContainEqual({ name: "thingId", in: "path", required: true, type: "string" }); // inherited
    expect(put.hasBody).toBe(true); // requestBody exists (schema $ref not resolved)

    const search = ops.find((o) => o.operationId === "searchThings")!;
    expect(search.params[0]).toEqual({ name: "filter", in: "query", required: false, type: "string" });
  });

  it("synthesizes an operationId when missing", () => {
    const ops = parseOperations({ paths: { "/x": { get: {} } } });
    expect(ops[0].operationId).toBe("GET_/x");
  });

  it("captures securitySchemes from op.security", () => {
    const spec = {
      paths: {
        "/api/2/connections": {
          get: {
            operationId: "getConnections",
            summary: "list connections",
            security: [{ DevOpsBasic: [] }],
          },
        },
      },
    };
    const ops = parseOperations(spec);
    expect(ops[0].securitySchemes).toEqual(["DevOpsBasic"]);
  });

  it("captures securitySchemes from spec-level security when op.security is missing", () => {
    const spec = {
      security: [{ ApiKeyAuth: [] }],
      paths: {
        "/things": {
          get: { operationId: "getThings", summary: "list things" },
        },
      },
    };
    const ops = parseOperations(spec);
    expect(ops[0].securitySchemes).toEqual(["ApiKeyAuth"]);
  });

  it("returns empty securitySchemes when no security is defined", () => {
    const spec = {
      paths: {
        "/public": {
          get: { operationId: "getPublic", summary: "public endpoint" },
        },
      },
    };
    const ops = parseOperations(spec);
    expect(ops[0].securitySchemes).toEqual([]);
  });

  it("resolves a requestBody object schema ($ref) into a shallow BodySchema", () => {
    const spec = {
      components: { schemas: { NewThing: { type: "object", required: ["thingId"], properties: {
        thingId: { type: "string" }, attributes: { type: "object" }, counter: { type: "integer" } } } } },
      paths: { "/things": { post: { operationId: "postThing",
        requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/NewThing" } } } } } } },
    };
    const ops = parseOperations(spec);
    const postOp = ops.find((o) => o.operationId === "postThing")!;
    expect(postOp.hasBody).toBe(true);
    expect(postOp.bodySchema?.props).toContainEqual({ name: "thingId", type: "string", required: true });
    expect(postOp.bodySchema?.props).toContainEqual({ name: "counter", type: "number", required: false });
    expect(postOp.bodySchema?.props).toContainEqual({ name: "attributes", type: "object", required: false });
  });

  it("takes the body media type from the requestBody and derives the body schema from it", () => {
    // Ditto's PATCH routes accept only merge-patch; there is no application/json entry.
    const spec = {
      paths: { "/things/{thingId}": { patch: { operationId: "patchThing",
        requestBody: { content: { "application/merge-patch+json": { schema: { type: "object", properties: {
          attributes: { type: "object" } } } } } } } } },
    };
    const [patch] = parseOperations(spec);
    expect(patch.contentType).toBe("application/merge-patch+json");
    expect(patch.bodySchema?.props).toEqual([{ name: "attributes", type: "object", required: false }]);
  });

  it("recognizes application/json with parameters and never sends a wildcard type", () => {
    const obj = { type: "object", properties: { a: { type: "string" } } };
    const spec = { paths: {
      "/x": { post: { operationId: "withParams", requestBody: { content: {
        "*/*": { schema: { type: "object", properties: { other: { type: "string" } } } },
        "application/json; charset=utf-8": { schema: obj },
      } } } },
      "/y": { post: { operationId: "wildcardOnly", requestBody: { content: { "*/*": { schema: obj } } } } },
    } };
    const [withParams, wildcardOnly] = parseOperations(spec);
    expect(withParams.contentType).toBe("application/json; charset=utf-8");
    expect(withParams.bodySchema?.props).toEqual([{ name: "a", type: "string", required: false }]);
    expect(wildcardOnly.contentType).toBe("application/json");
    expect(wildcardOnly.bodySchema?.props).toEqual([{ name: "a", type: "string", required: false }]);
  });

  it("marks no field of a merge-patch body as required", () => {
    // RFC 7386: a merge patch carries only what changes. Ditto's PatchThing still lists
    // required: [thingId, policyId], which would push a model to send (or guess) a policyId.
    const spec = {
      paths: { "/things/{thingId}": { patch: { operationId: "patchThing",
        requestBody: { content: { "application/merge-patch+json": { schema: { type: "object",
          required: ["policyId"], properties: { policyId: { type: "string" }, attributes: { type: "object" } } } } } } } } },
    };
    const [patch] = parseOperations(spec);
    expect(patch.bodySchema?.props).toEqual([
      { name: "policyId", type: "string", required: false },
      { name: "attributes", type: "object", required: false },
    ]);
  });

  it("resolves a $ref'd requestBody from components.requestBodies", () => {
    const spec = {
      components: { requestBodies: { PatchValue: { content: { "application/merge-patch+json": {
        schema: { type: "object", properties: { v: { type: "number" } } } } } } } },
      paths: { "/things/{thingId}/attributes/{attributePath}": { patch: { operationId: "patchAttribute",
        requestBody: { $ref: "#/components/requestBodies/PatchValue" } } } },
    };
    const [patch] = parseOperations(spec);
    expect(patch.hasBody).toBe(true);
    expect(patch.contentType).toBe("application/merge-patch+json");
    expect(patch.bodySchema?.props).toEqual([{ name: "v", type: "number", required: false }]);
  });

  it("prefers application/json when an operation accepts several media types", () => {
    const spec = {
      paths: { "/messages": { post: { operationId: "sendMessage",
        requestBody: { content: {
          "text/plain": { schema: { type: "string" } },
          "application/json": { schema: { type: "object", properties: { a: { type: "string" } } } },
          "application/octet-stream": {},
        } } } } },
    };
    const [send] = parseOperations(spec);
    expect(send.contentType).toBe("application/json");
    expect(send.bodySchema?.props).toEqual([{ name: "a", type: "string", required: false }]);
  });

  it("marks a $ref or allOf/oneOf/anyOf body property as type 'unknown' (not string)", () => {
    const spec = {
      components: { schemas: {
        ComplexThing: { type: "object", required: ["policyId"], properties: {
          policyId: { type: "string" },
          attributes: { $ref: "#/components/schemas/Attributes" },
          _policy: { allOf: [{ $ref: "#/components/schemas/Policy" }] },
          features: { oneOf: [{ type: "object" }, { type: "null" }] },
        }},
      }},
      paths: { "/things": { put: { operationId: "putComplexThing",
        requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/ComplexThing" } } } } } } },
    };
    const ops = parseOperations(spec);
    const putOp = ops.find((o) => o.operationId === "putComplexThing")!;
    expect(putOp.bodySchema?.props).toContainEqual({ name: "policyId", type: "string", required: true });
    expect(putOp.bodySchema?.props).toContainEqual({ name: "attributes", type: "unknown", required: false });
    expect(putOp.bodySchema?.props).toContainEqual({ name: "_policy", type: "unknown", required: false });
    expect(putOp.bodySchema?.props).toContainEqual({ name: "features", type: "unknown", required: false });
  });
});
