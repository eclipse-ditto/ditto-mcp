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

import { describe, it, expect, afterEach } from "vitest";
import { makeActionTools, buildVersionUrl } from "./action-tools.js";
import { HttpDittoClient } from "./client.js";
import { startFakeDitto } from "./fake-ditto.js";
import { AppConfigSchema } from "../config/schema.js";

describe("buildVersionUrl", () => {
  it("substitutes the ${version} placeholder", () => {
    const template =
      "https://raw.githubusercontent.com/eclipse-ditto/ditto/${version}/documentation/src/main/resources/openapi/ditto-api-2.yml";
    expect(buildVersionUrl(template, "3.6.0")).toBe(
      "https://raw.githubusercontent.com/eclipse-ditto/ditto/3.6.0/documentation/src/main/resources/openapi/ditto-api-2.yml",
    );
  });

  it("substitutes every occurrence", () => {
    expect(buildVersionUrl("a/${version}/b/${version}", "1.2.3")).toBe("a/1.2.3/b/1.2.3");
  });
});

const SPEC = {
  paths: {
    "/things/{thingId}": {
      get: { operationId: "getThingById", summary: "get", parameters: [{ name: "thingId", in: "path", required: true, schema: { type: "string" } }] },
      put: { operationId: "putThing", summary: "put", parameters: [{ name: "thingId", in: "path", required: true, schema: { type: "string" } }], requestBody: {} },
    },
    "/sudo/things/{thingId}": {
      get: { operationId: "sudoRetrieveThing", summary: "sudo get", parameters: [{ name: "thingId", in: "path", required: true, schema: { type: "string" } }] },
    },
  },
};

let fake: Awaited<ReturnType<typeof startFakeDitto>>;
afterEach(async () => { await fake?.stop(); });

async function tools(policy: object, credKind = "basic") {
  fake = await startFakeDitto((req) => ({ status: 200, body: JSON.stringify({ url: req.url }) }));
  const config = AppConfigSchema.parse({
    ditto: { enabled: true, baseUrl: fake.baseUrl, credential: { kind: credKind, username: "u", password: "p" }, policy },
  });
  const list = await makeActionTools(config, { loadSpec: async () => SPEC, client: new HttpDittoClient(fake.baseUrl) });
  return { config, byName: Object.fromEntries(list.map((t) => [t.name, t])) };
}

describe("makeActionTools", () => {
  it("registers only GET (read-only) by default", async () => {
    const { byName } = await tools({ allowMethods: ["GET"], writeAllowlist: [], sudoAllowlist: [] });
    expect(byName.ditto_getThingById).toBeDefined();
    expect(byName.ditto_putThing).toBeUndefined();          // write blocked
    expect(byName.ditto_sudoRetrieveThing).toBeUndefined();  // sudo blocked
  });

  it("includes a write when allowlisted and a sudo when sudoAllowlisted", async () => {
    const { byName } = await tools({ allowMethods: ["GET"], writeAllowlist: ["putThing"], sudoAllowlist: ["sudoRetrieveThing"] });
    expect(byName.ditto_putThing).toBeDefined();
    expect(byName.ditto_sudoRetrieveThing).toBeDefined();
  });

  it("a registered GET tool calls the fake Ditto", async () => {
    const { byName, config } = await tools({ allowMethods: ["GET"], writeAllowlist: [], sudoAllowlist: [] });
    const res = await byName.ditto_getThingById.handler({ thingId: "ns:1" }, { config, headers: {} } as never);
    expect(res.content[0].text).toContain("/things/ns:1");
  });

  it("de-duplicates colliding tool names by appending _2, _3, ...", async () => {
    const specWithCollision = {
      paths: {
        "/a": { get: { operationId: "foo-bar", summary: "a" } },
        "/b": { get: { operationId: "foo/bar", summary: "b" } },
        "/c": { get: { operationId: "foo.bar", summary: "c" } },
      },
    };
    fake = await startFakeDitto(() => ({ status: 200, body: "{}" }));
    const config = AppConfigSchema.parse({
      ditto: { enabled: true, baseUrl: fake.baseUrl, credential: { kind: "basic", username: "u", password: "p" }, policy: { allowMethods: ["GET"], writeAllowlist: [], sudoAllowlist: [] } },
    });
    const list = await makeActionTools(config, { loadSpec: async () => specWithCollision, client: new HttpDittoClient(fake.baseUrl) });
    const names = list.map((t) => t.name);
    expect(names).toContain("ditto_foo_bar");
    expect(names).toContain("ditto_foo_bar_2");
    expect(names).toContain("ditto_foo_bar_3");
    expect(names.length).toBe(3);
  });

  it("names an operation without operationId by method and path, minus /api/2 and inner path params", async () => {
    // The two DELETEs used to truncate to the same 64 chars: "delete all" vs "delete one".
    const desired = "/api/2/things/{thingId}/features/{featureId}/desiredProperties";
    const specNoOpId = {
      paths: {
        "/api/2/things": { get: { summary: "list" } },
        "/api/2/things/{thingId}": { get: { summary: "get" } },
        [desired]: { delete: { summary: "delete all" } },
        [`${desired}/{propertyPath}`]: { delete: { summary: "delete one" } },
      },
    };
    const config = AppConfigSchema.parse({
      ditto: { enabled: true, baseUrl: "http://ditto", policy: { allowMethods: ["GET", "DELETE"] } },
    });
    const list = await makeActionTools(config, { loadSpec: async () => specNoOpId });
    expect(list.map((t) => t.name)).toEqual([
      "ditto_GET_things",
      "ditto_GET_things_thingId",
      "ditto_DELETE_things_features_desiredProperties",
      "ditto_DELETE_things_features_desiredProperties_propertyPath",
    ]);
  });

  it("shortens a name over 64 chars with a hash of its operation, keeping names distinct", async () => {
    const shared = "a".repeat(70);
    const spec = { paths: {
      "/x": { get: { operationId: `${shared}One` } },
      "/y": { get: { operationId: `${shared}Two` } },
    } };
    const config = AppConfigSchema.parse({ ditto: { enabled: true, baseUrl: "http://ditto" } });
    const [x, y] = (await makeActionTools(config, { loadSpec: async () => spec })).map((t) => t.name);
    expect(x).toMatch(/^ditto_a{49}_[0-9a-f]{8}$/);
    expect(y).toMatch(/^ditto_a{49}_[0-9a-f]{8}$/);
    expect(x).not.toBe(y);
  });

  it("picks a de-duplication suffix that no other tool already uses", async () => {
    // "/a/{p}/b" and "/a/b" share a name; "/a/b/2" already owns the "_2" the second would get.
    const spec = { paths: { "/a/{p}/b": { get: {} }, "/a/b": { get: {} }, "/a/b/2": { get: {} } } };
    const config = AppConfigSchema.parse({ ditto: { enabled: true, baseUrl: "http://ditto" } });
    const names = (await makeActionTools(config, { loadSpec: async () => spec })).map((t) => t.name);
    expect(names).toEqual(["ditto_GET_a_b", "ditto_GET_a_b_2", "ditto_GET_a_b_2_2"]);
  });

  it("keeps a de-duplicated name within 64 chars", async () => {
    // Both sanitize to the same 58 chars, so the base name is exactly 64 long.
    const spec = { paths: {
      "/x": { get: { operationId: `${"a".repeat(28)}-${"b".repeat(29)}` } },
      "/y": { get: { operationId: `${"a".repeat(28)}.${"b".repeat(29)}` } },
    } };
    const config = AppConfigSchema.parse({ ditto: { enabled: true, baseUrl: "http://ditto" } });
    const names = (await makeActionTools(config, { loadSpec: async () => spec })).map((t) => t.name);
    const base = `ditto_${"a".repeat(28)}_${"b".repeat(29)}`;
    expect(names).toEqual([base, `${base.slice(0, 62)}_2`]);
  });

  it("fails, naming the cause, when the spec cannot be loaded", async () => {
    // Built once at startup: silently serving no action tools would last until a restart.
    const config = AppConfigSchema.parse({ ditto: { enabled: true, baseUrl: "http://ditto" } });
    await expect(makeActionTools(config, {
      loadSpec: async () => { throw new Error("openapi fetch https://mirror/spec.yml -> 503"); },
    })).rejects.toThrow(/Ditto action tools.*openapi fetch https:\/\/mirror\/spec\.yml -> 503/);
  });

  it("fails when ditto is enabled without a baseUrl", async () => {
    const config = AppConfigSchema.parse({ ditto: { enabled: true } });
    await expect(makeActionTools(config, { loadSpec: async () => SPEC })).rejects.toThrow(/ditto\.baseUrl/);
  });

  it("a sudo tool refuses at call time when no devopsCredential is configured", async () => {
    const { byName, config } = await tools({ allowMethods: ["GET"], writeAllowlist: [], sudoAllowlist: ["sudoRetrieveThing"] });
    const res = await byName.ditto_sudoRetrieveThing.handler({ thingId: "ns:1" }, { config, headers: {} } as never);
    expect(res.content[0].text.toLowerCase()).toContain("devopscredential");
  });
});
