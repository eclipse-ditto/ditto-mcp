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
- `express.json` takes `server.http.maxRequestBytes` (default 4 MiB, the SDK's own limit; Ditto accepts things and policies up to 100 kB and messages up to 250 kB). The error middleware, registered last, turns body-parser errors into JSON-RPC: too large is 413 / `-32600`, malformed JSON is 400 / `-32700`, another 4xx keeps its status with `-32600`, anything else is logged and gets 500 / `-32603`. Every reply from `/mcp` is JSON-RPC, never Express's HTML error page.

## SessionTable invariants (`session-table.ts`)
- sessions − doomed + pending ≤ `maxSessions` at all times, even with concurrent initializes.
- Eviction picks the least recently active idle session, but only if it has gone without a request for at least `sessionEvictionMinIdleMs`. Failing that, it picks a busy session inactive for longer than `sessionIdleTimeoutMs` (a stream to a client that vanished). A recently used session is never evicted, idle or busy: a Streamable HTTP client has no request open between calls, and evicting it makes it re-initialize and evict the next one, so sessions would churn. The newcomer gets 503 instead.
- `sweep()` runs on an `unref`ed interval of min(idle timeout, 60 s) and closes idle sessions past the timeout.
- `settle` is idempotent, so `release` after `add` is a no-op. `close` ignores a session that is already gone.
- The clock is injected (`now`). Never call `Date.now()` directly inside the class.

## Entrypoints
- Each one has the same shape: `async function main()`, then `main().catch(err => { stderr "...fatal: ..."; process.exit(1) })`.
- Config comes only from the `DITTO_MCP_CONFIG` env var.
- `bin/http.ts` handles `SIGTERM`/`SIGINT` (`process.once`): `server.close()`, then `app.closeSessions()` (event streams never end on their own and would hold `close()` open), then `closeIdleConnections()`; a 5 s unref'ed backstop exits with 1. Keep it: in the container node is PID 1, which gets no default signal action, so without the handler `docker stop` waits for SIGKILL.
- `bin/*.ts` start with `#!/usr/bin/env node`. `package.json` `bin` maps `ditto-mcp-{stdio,http,ingest}` to `dist/bin/*.js`.
