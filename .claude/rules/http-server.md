---
paths:
  - "src/server/**"
  - "src/bin/**"
---

# Transports and the MCP server

## Shape
- `buildServer(registry, config)` wraps a `ToolRegistry` in the SDK's `McpServer`. Each tool handler receives `buildCtx(config, extra)`, a `RequestCtx` with config, sessionId, headers, and signal.
- stdio (`bin/stdio.ts`): a single McpServer on `StdioServerTransport`. For local use.
- HTTP (`bin/http.ts`, which calls `createHttpApp`): Express with a single route, `/mcp` (POST/GET/DELETE), on the SDK's `StreamableHTTPServerTransport`. This is the production deployment (Docker).
- `bin/*` builds the `ToolRegistry` once, and every session shares it. Never build tools or credentials per session: that re-reads the spec and empties the OIDC token caches. Only the `McpServer` and its transport are per session.
- When the registry is empty, `buildServer` registers a disabled `_init` placeholder, because SDK 1.29 only sets up the tools/list handler once a tool is registered. Keep it.
- The server version comes from `package.json` through `createRequire`; that is the only place to bump it.

## HTTP request flow (`http-app.ts`)
1. If `auth.mode` is `"bearer"`, the bearer middleware runs on `/mcp` before `express.json()`.
2. A POST with a known `mcp-session-id` goes to that session's transport.
3. A POST with an unknown session id gets **404**, which the MCP spec reserves for "re-initialize". Not 400.
4. A POST without a session id that isn't an `initialize` gets 400.
5. An `initialize`:
   1. `sessions.reserve()` decides synchronously whether there is room; if the cap is reached and nothing can be evicted, the reply is 503.
   2. A new transport is created.
   3. `onsessioninitialized` calls `sessions.add()`. Only now, after the transport's Host/Origin checks have passed, is the reserved victim closed.
   4. If the request ended before that, `add` returns `undefined` and the new transport is closed.
6. GET (the event stream) and DELETE go to an existing session, or get 404 for an unknown id, or 400 without one.
- `track` counts every request on a session: `openRequests` goes up and comes back down when `res` closes. A session with an open request is busy.
- On errors: log `[ditto-mcp] <METHOD> /mcp error: ...` to stderr, and reply with JSON-RPC `-32603 "Internal error"` if no headers have been sent yet.

## SessionTable invariants (`session-table.ts`)
- sessions − doomed + pending ≤ `maxSessions` at all times, even with concurrent initializes.
- Eviction picks the least recently active idle session. Failing that, it picks a busy session inactive for longer than `sessionIdleTimeoutMs` (a stream to a client that vanished). A busy session that was recently active is never evicted.
- `sweep()` runs on an `unref`ed interval of min(idle timeout, 60 s) and closes idle sessions past the timeout.
- `settle` is idempotent, so `release` after `add` is a no-op. `close` ignores a session that is already gone.
- The clock is injected (`now`). Never call `Date.now()` directly inside the class.

## Entrypoints
- Each one has the same shape: `async function main()`, then `main().catch(err => { stderr "...fatal: ..."; process.exit(1) })`.
- Config comes only from the `DITTO_MCP_CONFIG` env var.
- `bin/*.ts` start with `#!/usr/bin/env node`. `package.json` `bin` maps `ditto-mcp-{stdio,http,ingest}` to `dist/bin/*.js`.
