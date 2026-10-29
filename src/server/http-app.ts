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

import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { AppConfig, HttpAuthConfig } from "../config/schema.js";
import type { ToolRegistry } from "../registry/tool-registry.js";
import { buildServer } from "./build-server.js";
import { SessionTable, type Session } from "./session-table.js";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** Compare via fixed-width digests so neither the value nor its length leaks through timing. */
function secretEquals(a: string, b: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(a).digest(),
    createHash("sha256").update(b).digest(),
  );
}

/**
 * Remove a header so downstream handlers cannot see it. The MCP SDK converts the Node
 * request into a web-standard `Request` via Hono, which reads `rawHeaders` and ignores
 * `headers` — so both have to be scrubbed or the value still reaches tool handlers.
 */
function stripHeader(req: Request, name: string): void {
  delete req.headers[name];
  const raw = req.rawHeaders;
  for (let i = raw.length - 2; i >= 0; i -= 2) {
    if (raw[i].toLowerCase() === name) raw.splice(i, 2);
  }
}

function bearerAuthMiddleware(auth: HttpAuthConfig) {
  const expected = auth.tokenFile
    ? readFileSync(auth.tokenFile, "utf8").trim()
    : auth.token;
  if (!expected) {
    throw new Error(
      "server.http.auth.mode is 'bearer' but neither token nor tokenFile is set",
    );
  }
  return (req: Request, res: Response, next: NextFunction): void => {
    const raw = req.headers.authorization;
    const value = Array.isArray(raw) ? raw[0] : raw;
    const match = value?.match(/^Bearer\s+(.+)$/i);
    if (!match || !secretEquals(match[1], expected)) {
      res.setHeader("WWW-Authenticate", "Bearer");
      res.status(401).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Unauthorized" },
        id: null,
      });
      return;
    }
    // The gate secret authenticates the caller to us; it is never a Ditto identity (Ditto
    // calls build their own headers from the configured credential). Drop it anyway so the
    // secret is not handed to tool handlers in the request context.
    stripHeader(req, "authorization");
    next();
  };
}

/**
 * `registry` is built once at startup and shared by every session: rebuilding it per session
 * re-read (or re-fetched) the OpenAPI spec and gave each session fresh credentials with empty
 * token caches. Only the McpServer and its transport are per session.
 */
export function createHttpApp(
  config: AppConfig,
  registry: ToolRegistry,
): Express {
  // Fail closed: an unauthenticated endpoint on a routable interface hands every caller the
  // server's Ditto identity — including `devopsCredential`, which reaches /devops and the
  // secret-bearing connectivity API. DNS-rebinding protection is a Host check, not access control.
  if (
    config.server.http.auth.mode === "none" &&
    !LOOPBACK.has(config.server.http.host)
  ) {
    throw new Error(
      `server.http.host is '${config.server.http.host}' but server.http.auth.mode is 'none': ` +
        `the /mcp endpoint would accept unauthenticated requests. Set server.http.auth ` +
        `(mode: "bearer", with token or tokenFile), or bind to 127.0.0.1.`,
    );
  }

  const app = express();

  // Gate before body parsing so unauthenticated requests cost as little as possible.
  if (config.server.http.auth.mode === "bearer") {
    app.use("/mcp", bearerAuthMiddleware(config.server.http.auth));
  }

  app.use(express.json());

  const { sessionIdleTimeoutMs, maxSessions } = config.server.http;
  const sessions = new SessionTable<StreamableHTTPServerTransport>(maxSessions, sessionIdleTimeoutMs);

  // Count a request against its session; the session is idle again once the response closes.
  const track = (session: Session<StreamableHTTPServerTransport>, res: Response): void => {
    sessions.begin(session);
    // A response that already closed (client gone) emits no further "close".
    if (res.closed) sessions.end(session);
    else res.on("close", () => sessions.end(session));
  };

  // Clients that crash or never send DELETE would otherwise keep their session, and its
  // McpServer, forever.
  setInterval(() => sessions.sweep(), Math.min(sessionIdleTimeoutMs, 60_000)).unref();

  // The MCP spec reserves 404 for a session id we don't know (expired, or issued before a
  // restart): it tells the client to start over with a fresh initialize. 400 would not.
  const sessionNotFound = (res: Response): void => {
    res.status(404).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Session not found" },
      id: null,
    });
  };

  app.post("/mcp", async (req: Request, res: Response) => {
    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      const session = sessionId ? sessions.get(sessionId) : undefined;
      let transport = session?.transport;

      if (session) track(session, res);
      if (!transport) {
        if (sessionId) {
          sessionNotFound(res);
          return;
        }
        if (!isInitializeRequest(req.body)) {
          res.status(400).json({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Bad Request: no valid session" },
            id: null,
          });
          return;
        }
        const reservation = sessions.reserve();
        if (!reservation) {
          res.status(503).json({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Too many sessions" },
            id: null,
          });
          return;
        }
        res.on("close", () => sessions.release(reservation));
        const http = config.server.http;
        const allowedHosts = http.allowedHosts ?? [
          `${http.host}:${http.port}`,
          `127.0.0.1:${http.port}`,
          `localhost:${http.port}`,
          `[::1]:${http.port}`,
        ];
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          // Runs only once the transport has accepted the initialize (Host/Origin checks passed).
          onsessioninitialized: (sid) => {
            const created = sessions.add(sid, transport as StreamableHTTPServerTransport, reservation);
            if (created) track(created, res);
            else void transport?.close(); // the client left before its session started
          },
          enableDnsRebindingProtection: http.enableDnsRebindingProtection,
          allowedHosts: http.enableDnsRebindingProtection
            ? allowedHosts
            : undefined,
          allowedOrigins: http.allowedOrigins,
        });
        transport.onclose = () => {
          if (transport?.sessionId) sessions.remove(transport.sessionId);
        };
        const server = buildServer(registry, config);
        await server.connect(transport);
      }

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      process.stderr.write(
        `[ditto-mcp] POST /mcp error: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal error" },
          id: null,
        });
      }
    }
  });

  const handleSession = async (req: Request, res: Response) => {
    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (!sessionId) {
        res.status(400).send("Missing session ID");
        return;
      }
      const session = sessions.get(sessionId);
      if (!session) {
        sessionNotFound(res);
        return;
      }
      track(session, res);
      await session.transport.handleRequest(req, res);
    } catch (error) {
      process.stderr.write(
        `[ditto-mcp] ${req.method} /mcp error: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal error" },
          id: null,
        });
      }
    }
  };

  app.get("/mcp", handleSession);
  app.delete("/mcp", handleSession);

  const http = config.server.http;
  if (
    http.enableDnsRebindingProtection &&
    !http.allowedHosts &&
    !LOOPBACK.has(http.host)
  ) {
    process.stderr.write(
      `[ditto-mcp] WARNING: host '${http.host}' is non-loopback but server.http.allowedHosts is not set; ` +
        `DNS-rebinding protection will 403 remote requests whose Host header is not in the derived loopback allowlist. ` +
        `Set server.http.allowedHosts explicitly for remote deployments.\n`,
    );
  }

  return app;
}
