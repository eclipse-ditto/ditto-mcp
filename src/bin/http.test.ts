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
import { spawn } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "http.ts");

function runWith(config: unknown): Promise<{ code: number | null; stderr: string }> {
  const cfgPath = join(mkdtempSync(join(tmpdir(), "ditto-mcp-http-")), "config.json");
  writeFileSync(cfgPath, JSON.stringify(config));
  const child = spawn(process.execPath, ["--import", "tsx", entry], {
    env: { ...process.env, DITTO_MCP_CONFIG: cfgPath },
  });
  let stderr = "";
  child.stderr.on("data", (c) => {
    stderr += String(c);
  });
  // A server that should have exited but keeps running must not outlive the test.
  const timer = setTimeout(() => child.kill(), 20_000);
  return new Promise((res) => child.on("close", (code) => {
    clearTimeout(timer);
    res({ code, stderr });
  }));
}

describe("http entrypoint (spawn e2e)", () => {
  it("exits with a readable error when told to bind a public interface unauthenticated", async () => {
    const { code, stderr } = await runWith({
      server: { http: { host: "0.0.0.0" } },
      knowledge: { enabled: false },
    });

    expect(code).toBe(1);
    expect(stderr).toContain("[ditto-mcp] fatal:");
    expect(stderr).toContain("server.http.auth");
    // An operator hitting this on first run should get the fix, not a V8 stack trace.
    expect(stderr).not.toContain("at createHttpApp");
  }, 30_000);

  it("exits with a readable error when the OpenAPI spec cannot be loaded", async () => {
    // fetch refuses port 9 outright ("bad port"): a spec URL that cannot be reached.
    const { code, stderr } = await runWith({
      knowledge: { enabled: false },
      ditto: { enabled: true, baseUrl: "http://127.0.0.1:9", openApi: { url: "http://127.0.0.1:9/spec.yml" } },
    });

    expect(code).toBe(1);
    expect(stderr).toContain("[ditto-mcp] fatal:");
    expect(stderr).toContain("http://127.0.0.1:9/spec.yml");
  }, 30_000);

  it("shuts down promptly on SIGTERM, closing open sessions", async () => {
    // As PID 1 in a container, node gets no default action for SIGTERM: without a handler,
    // `docker stop` waits out its grace period and SIGKILLs the server.
    const port = await new Promise<number>((res) => {
      const probe = createServer().listen(0, "127.0.0.1", () => {
        const { port } = probe.address() as AddressInfo;
        probe.close(() => res(port));
      });
    });
    const cfgPath = join(mkdtempSync(join(tmpdir(), "ditto-mcp-http-")), "config.json");
    writeFileSync(cfgPath, JSON.stringify({ server: { http: { port } }, knowledge: { enabled: false } }));
    const child = spawn(process.execPath, ["--import", "tsx", entry], {
      env: { ...process.env, DITTO_MCP_CONFIG: cfgPath },
    });
    let stderr = "";
    const exited = new Promise<{ code: number | null; signal: string | null }>((res) =>
      child.on("close", (code, signal) => res({ code, signal })));
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    try {
      await new Promise<void>((res) => child.stderr.on("data", (c) => {
        stderr += String(c);
        if (stderr.includes("listening")) res();
      }));
      // A connected client holds its event stream open, which alone would keep the server open.
      const client = new Client({ name: "t", version: "1" });
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
      await client.ping();

      const started = Date.now();
      child.kill("SIGTERM");
      const { code, signal } = await exited;
      expect({ code, signal }).toEqual({ code: 0, signal: null });
      expect(Date.now() - started).toBeLessThan(3_000); // not the 5 s backstop
      expect(stderr).toContain("SIGTERM");
      await client.close().catch(() => undefined);
    } finally {
      clearTimeout(timer);
      child.kill("SIGKILL");
    }
  }, 30_000);
});
