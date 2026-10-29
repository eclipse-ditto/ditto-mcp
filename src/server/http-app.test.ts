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
import { request } from "node:http";
import type { Server } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AppConfigSchema } from "../config/schema.js";
import { startFakeDitto } from "../ditto/fake-ditto.js";
import { createHttpApp } from "./http-app.js";
import { registerTools } from "../tools/index.js";
import { ToolRegistry } from "../registry/tool-registry.js";
import { startFakeOidc } from "../ditto/fake-oidc.js";

async function listen(http: Record<string, unknown> = {}): Promise<{ server: Server; url: string }> {
  // protocol e2e; DNS-rebinding protection exercised separately below.
  // knowledge disabled to keep this transport test hermetic; knowledge covered in knowledge tests.
  const config = AppConfigSchema.parse({
    server: { http: { enableDnsRebindingProtection: false, ...http } },
    knowledge: { enabled: false },
  });
  const app = createHttpApp(config, await registerTools(config));
  return await new Promise((res) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      res({ server, url: `http://127.0.0.1:${port}/mcp` });
    });
  });
}

const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

const INITIALIZE = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test", version: "1.0" },
  },
});

const SPEC_YML = [
  "openapi: 3.0.0",
  'info: { title: t, version: "1" }',
  "paths:",
  "  /things/{thingId}:",
  "    get:",
  "      operationId: getThingById",
  "      summary: get a thing",
  "      parameters:",
  "        - name: thingId",
  "          in: path",
  "          required: true",
  "          schema: { type: string }",
].join("\n");

/** An app with real action tools pointed at a fake Ditto, so we can inspect what it sends upstream. */
async function listenWithDitto(
  http: Record<string, unknown>,
  credential: object = { kind: "basic", username: "svc", password: "pw" },
): Promise<{
  url: string;
  fake: Awaited<ReturnType<typeof startFakeDitto>>;
  stop: () => Promise<void>;
}> {
  const fake = await startFakeDitto(() => ({ status: 200, body: "{}" }));
  const specPath = join(mkdtempSync(join(tmpdir(), "mcp-auth-")), "spec.yml");
  writeFileSync(specPath, SPEC_YML);
  const config = AppConfigSchema.parse({
    server: { http: { enableDnsRebindingProtection: false, ...http } },
    knowledge: { enabled: false },
    ditto: {
      enabled: true,
      baseUrl: fake.baseUrl,
      openApi: { path: specPath },
      credential,
      policy: { allowMethods: ["GET"] },
    },
  });
  const app = createHttpApp(config, await registerTools(config));
  const server = await new Promise<Server>((res) => {
    const srv = app.listen(0, () => res(srv));
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    fake,
    stop: async () => {
      await new Promise<void>((r) => server.close(() => r()));
      await fake.stop();
    },
  };
}

async function callThing(url: string, headers: Record<string, string>): Promise<void> {
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } });
  const client = new Client({ name: "http-test", version: "0.0.0" });
  await client.connect(transport);
  await client.callTool({ name: "ditto_getThingById", arguments: { thingId: "ns:thing" } });
  await client.close();
}

describe("streamable HTTP app (e2e)", () => {
  it("serves ping over streamable HTTP with a session", async () => {
    const { server, url } = await listen();
    const transport = new StreamableHTTPClientTransport(new URL(url));
    const client = new Client({ name: "http-test", version: "0.0.0" });
    await client.connect(transport);
    const res = await client.callTool({ name: "ping", arguments: {} });
    const content = res.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toBe("pong");
    await client.close();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("rejects prototype pollution attempts without crashing", async () => {
    const { server, url } = await listen();
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "mcp-session-id": "__proto__",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "ping", arguments: {} },
      }),
    });
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.message).toBe("Session not found");
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("answers an unknown session id with 404, the client's signal to re-initialize", async () => {
    // After a restart the client still holds its old session id; 400 would leave it stuck.
    const { server, url } = await listen();
    const headers = { ...MCP_HEADERS, "mcp-session-id": "6d0f3a52-0000-4000-8000-000000000000" };
    const ping = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" });
    expect((await fetch(url, { method: "POST", headers, body: ping })).status).toBe(404);
    expect((await fetch(url, { method: "GET", headers })).status).toBe(404);
    expect((await fetch(url, { method: "DELETE", headers })).status).toBe(404);
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("answers a non-initialize request without a session id with 400", async () => {
    const { server, url } = await listen();
    const ping = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" });
    expect((await fetch(url, { method: "POST", headers: MCP_HEADERS, body: ping })).status).toBe(400);
    expect((await fetch(url, { method: "GET", headers: MCP_HEADERS })).status).toBe(400);
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("rejects DNS rebinding attacks by default", async () => {
    // Default config has DNS-rebinding protection enabled
    // knowledge disabled to keep this transport test hermetic; knowledge covered in knowledge tests.
    const config = AppConfigSchema.parse({ knowledge: { enabled: false } });
    const app = createHttpApp(config, new ToolRegistry());
    const server = await new Promise<Server>((res) => {
      const srv = app.listen(0, () => res(srv));
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "attacker", version: "1.0" },
      },
    });

    const statusCode = await new Promise<number>((resolve) => {
      const req = request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/mcp",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
            host: "attacker.example",
          },
        },
        (res) => {
          resolve(res.statusCode ?? 0);
        },
      );
      req.write(body);
      req.end();
    });

    expect(statusCode).toBe(403);
    await new Promise<void>((r) => server.close(() => r()));
  });
});

/** Open a session with a bare initialize (no client event stream) and return its id. */
async function initSession(url: string): Promise<string> {
  const res = await fetch(url, { method: "POST", headers: MCP_HEADERS, body: INITIALIZE });
  await res.text();
  return res.headers.get("mcp-session-id")!;
}

async function pingStatus(url: string, sessionId: string): Promise<number> {
  const res = await fetch(url, {
    method: "POST",
    headers: { ...MCP_HEADERS, "mcp-session-id": sessionId },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }),
  });
  await res.text();
  return res.status;
}

async function connectClient(url: string): Promise<{ client: Client; sessionId: string }> {
  const client = new Client({ name: "http-test", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url));
  await client.connect(transport);
  return { client, sessionId: transport.sessionId! };
}

/** POST with an explicit Host header, which fetch cannot set. */
function postWithHost(
  url: string, host: string, body: string, sessionId?: string,
): Promise<{ status: number; sessionId?: string }> {
  const { port } = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1", port, path: "/mcp", method: "POST",
        headers: {
          ...MCP_HEADERS, host, "Content-Length": Buffer.byteLength(body),
          ...(sessionId ? { "mcp-session-id": sessionId } : {}),
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve({
          status: res.statusCode ?? 0, sessionId: res.headers["mcp-session-id"] as string | undefined,
        }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("session lifetime", () => {
  it("closes a session idle longer than sessionIdleTimeoutMs", async () => {
    // Clients that crash or never send DELETE would otherwise hold their session forever.
    const { server, url } = await listen({ sessionIdleTimeoutMs: 50 });
    const sid = await initSession(url);
    expect(await pingStatus(url, sid)).toBe(200);
    await sleep(250);
    expect(await pingStatus(url, sid)).toBe(404);
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("keeps an idle-timed session alive while its client holds an event stream open", async () => {
    const { server, url } = await listen({ sessionIdleTimeoutMs: 50 });
    const { client } = await connectClient(url);
    await sleep(250);
    const res = await client.callTool({ name: "ping", arguments: {} });
    expect((res.content as Array<{ text: string }>)[0].text).toBe("pong");
    await client.close();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("at maxSessions, closes the least recently active idle session to admit a new one", async () => {
    const { server, url } = await listen({ maxSessions: 2 });
    const a = await initSession(url);
    const b = await initSession(url);
    expect(await pingStatus(url, a)).toBe(200); // b is now the least recently active
    const c = await initSession(url);
    expect(await pingStatus(url, b)).toBe(404);
    expect(await pingStatus(url, a)).toBe(200);
    expect(await pingStatus(url, c)).toBe(200);
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("at maxSessions, closes a busy session inactive longer than the idle timeout", async () => {
    // A stream to a vanished client may never close; it must not hold its slot forever.
    const { server, url } = await listen({ maxSessions: 1, sessionIdleTimeoutMs: 50 });
    const { client, sessionId: busy } = await connectClient(url); // holds its event stream open
    await sleep(150);
    const fresh = await initSession(url);
    expect(await pingStatus(url, busy)).toBe(404);
    expect(await pingStatus(url, fresh)).toBe(200);
    await client.close();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("at maxSessions, refuses a new initialize with 503 rather than close a recently active busy session", async () => {
    const { server, url } = await listen({ maxSessions: 1 });
    const { client } = await connectClient(url); // busy: holds its event stream open
    const res = await fetch(url, { method: "POST", headers: MCP_HEADERS, body: INITIALIZE });
    expect(res.status).toBe(503);
    const pong = await client.callTool({ name: "ping", arguments: {} });
    expect((pong.content as Array<{ text: string }>)[0].text).toBe("pong");
    await client.close();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("does not evict a session for an initialize that DNS-rebinding protection rejects", async () => {
    // The derived allowlist holds the configured port (3000), whatever port we really bound.
    const { server, url } = await listen({ enableDnsRebindingProtection: true, maxSessions: 1 });
    const ping = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" });
    const { sessionId } = await postWithHost(url, "127.0.0.1:3000", INITIALIZE);
    expect((await postWithHost(url, "attacker.example", INITIALIZE)).status).toBe(403);
    expect((await postWithHost(url, "127.0.0.1:3000", ping, sessionId)).status).toBe(200);
    await new Promise<void>((r) => server.close(() => r()));
  });
});

describe("tool set lifetime", () => {
  it("builds the tools once, so every session shares one OIDC token", async () => {
    // Per-session tools meant a new credential, and a new IdP token request, per session.
    const oidc = await startFakeOidc({ access_token: "tok", expires_in: 3600 });
    const { url, fake, stop } = await listenWithDitto({}, {
      kind: "oidc", tokenUrl: oidc.tokenUrl, clientId: "c", clientSecret: "s",
    });
    await callThing(url, {});
    await callThing(url, {});
    expect(fake.requests.map((r) => r.auth)).toEqual(["Bearer tok", "Bearer tok"]);
    expect(oidc.calls).toBe(1);
    await stop();
    await oidc.stop();
  });
});

describe("bearer auth on /mcp", () => {
  const BEARER = { auth: { mode: "bearer", token: "s3cret" } };

  it("rejects an initialize with no credential", async () => {
    const { server, url } = await listen(BEARER);
    const res = await fetch(url, {
      method: "POST",
      headers: MCP_HEADERS,
      body: INITIALIZE,
    });
    expect(res.status).toBe(401);
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("rejects an initialize with the wrong token", async () => {
    const { server, url } = await listen(BEARER);
    const res = await fetch(url, {
      method: "POST",
      headers: { ...MCP_HEADERS, authorization: "Bearer wrong" },
      body: INITIALIZE,
    });
    expect(res.status).toBe(401);
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("never forwards the gate credential to Ditto", async () => {
    // The gate secret authenticates the caller to *us*; it is not a Ditto identity.
    // If it reaches Ditto, the shared secret is leaked to every backend request.
    const { url, fake, stop } = await listenWithDitto(BEARER);
    await callThing(url, { authorization: "Bearer s3cret" });

    const seen = fake.requests.map((r) => r.auth ?? "");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(`Basic ${Buffer.from("svc:pw").toString("base64")}`);
    expect(seen[0]).not.toContain("s3cret");
    await stop();
  });

  it("never forwards a caller Authorization header to Ditto, even ungated", async () => {
    // mode "none" runs no gate, so the caller's header reaches the tool handlers untouched.
    // The server must still call Ditto only with its own configured credential.
    const { url, fake, stop } = await listenWithDitto({ auth: { mode: "none" } });
    await callThing(url, { authorization: "Basic Y2FsbGVyOnB3" });

    expect(fake.requests[0].auth).toBe(`Basic ${Buffer.from("svc:pw").toString("base64")}`);
    await stop();
  });

  it("requires the token on GET and DELETE too", async () => {
    const { server, url } = await listen(BEARER);
    for (const method of ["GET", "DELETE"]) {
      const res = await fetch(url, { method, headers: MCP_HEADERS });
      expect(res.status, method).toBe(401);
    }
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("reads the token from tokenFile", async () => {
    const tokenFile = join(mkdtempSync(join(tmpdir(), "mcp-tok-")), "token");
    writeFileSync(tokenFile, "from-a-file\n");
    const { server, url } = await listen({ auth: { mode: "bearer", tokenFile } });

    const bad = await fetch(url, { method: "POST", headers: MCP_HEADERS, body: INITIALIZE });
    expect(bad.status).toBe(401);
    const good = await fetch(url, {
      method: "POST",
      headers: { ...MCP_HEADERS, authorization: "Bearer from-a-file" },
      body: INITIALIZE,
    });
    expect(good.status).toBe(200);
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("refuses to start unauthenticated on a non-loopback host", () => {
    const config = AppConfigSchema.parse({
      server: { http: { host: "0.0.0.0" } },
      knowledge: { enabled: false },
    });
    expect(() => createHttpApp(config, new ToolRegistry())).toThrow(/auth/i);
  });

  it("serves ping when the correct token is supplied", async () => {
    const { server, url } = await listen(BEARER);
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { authorization: "Bearer s3cret" } },
    });
    const client = new Client({ name: "http-test", version: "0.0.0" });
    await client.connect(transport);
    const res = await client.callTool({ name: "ping", arguments: {} });
    const content = res.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toBe("pong");
    await client.close();
    await new Promise<void>((r) => server.close(() => r()));
  });
});
