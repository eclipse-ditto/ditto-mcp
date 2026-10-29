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
import { AppConfigSchema } from "../config/schema.js";
import { createConfigCredential, OidcClientCredential } from "./credential.js";
import { startFakeOidc } from "./fake-oidc.js";

const cred = (c: object) =>
  AppConfigSchema.parse({ ditto: { enabled: true, credential: c } }).ditto.credential;

describe("credentials", () => {
  it("basic → Basic header", async () => {
    const c = createConfigCredential(cred({ kind: "basic", username: "u", password: "p" }));
    expect(await c.authHeader()).toBe(`Basic ${Buffer.from("u:p").toString("base64")}`);
  });

  it("basic with no username → no header", async () => {
    const c = createConfigCredential(cred({ kind: "basic" }));
    expect(await c.authHeader()).toBeUndefined();
  });

  it("oidc fetches a bearer token and caches it (one token call for two uses)", async () => {
    const oidc = await startFakeOidc({ access_token: "tok123", expires_in: 3600 });
    try {
      const c = createConfigCredential(cred({ kind: "oidc", tokenUrl: oidc.tokenUrl, clientId: "c", clientSecret: "s" }));
      expect(await c.authHeader()).toBe("Bearer tok123");
      expect(await c.authHeader()).toBe("Bearer tok123");
      expect(oidc.calls).toBe(1);
    } finally { await oidc.stop(); }
  });

  it("oidc: a caller cancelling does not fail the others waiting on the same token fetch", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let calls = 0;
    const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls++;
      await gate;
      init?.signal?.throwIfAborted();
      return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }));
    }) as typeof fetch;
    const c = new OidcClientCredential({ tokenUrl: "http://idp/token", clientId: "c", clientSecret: "s" }, fetchFn);
    const cancelled = new AbortController();
    const first = c.authHeader(cancelled.signal);
    const second = c.authHeader(new AbortController().signal);
    cancelled.abort();
    release();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    await expect(second).resolves.toBe("Bearer tok");
    expect(calls).toBe(1);
  });

  it("oidc: an already-cancelled caller starts no token fetch and leaves no rejection unhandled", async () => {
    // A tools/call and its notifications/cancelled can arrive in one batch, so the handler may
    // start with an aborted signal. A failing fetch nobody awaits would crash the process.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      let calls = 0;
      const fetchFn = (async () => { calls++; throw new TypeError("fetch failed"); }) as typeof fetch;
      const c = new OidcClientCredential({ tokenUrl: "http://idp/token", clientId: "c", clientSecret: "s" }, fetchFn);
      await expect(c.authHeader(AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toEqual([]);
      expect(calls).toBe(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("oidc sends grant_type=client_credentials, Basic auth, and scope (when set)", async () => {
    const oidc = await startFakeOidc({ access_token: "tok", expires_in: 3600 });
    try {
      const c = createConfigCredential(cred({ kind: "oidc", tokenUrl: oidc.tokenUrl, clientId: "myClient", clientSecret: "mySecret", scope: "scope1 scope2" }));
      await c.authHeader();
      const req = oidc.requests[0];
      expect(req.method).toBe("POST");
      expect(req.headers.authorization).toBe(`Basic ${Buffer.from("myClient:mySecret").toString("base64")}`);
      expect(req.headers["content-type"]).toBe("application/x-www-form-urlencoded");
      expect(req.body).toContain("grant_type=client_credentials");
      expect(req.body).toContain("scope=scope1+scope2");
    } finally { await oidc.stop(); }
  });
});
