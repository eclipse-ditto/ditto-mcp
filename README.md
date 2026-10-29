# ditto-mcp
Eclipse Ditto™: Digital Twin framework - Model Context Protocol (MCP) server

Model Context Protocol (MCP) server for Eclipse Ditto. Provides two classes of tools:

1. **Knowledge tools** (`search`, `get_chunk`) — semantic/keyword search over Ditto documentation (public llms.txt + optional local markdown corpus)
2. **Action tools** (dynamically generated from OpenAPI) — query and manage Things, Policies, Connections, and other Ditto resources

## Requirements

- Node >= 22

## Quickstart

### Install & Build

```bash
git clone https://github.com/eclipse-ditto/ditto-mcp.git
cd ditto-mcp/
npm ci
npm run build
```

`npm run build` first downloads Ditto's OpenAPI spec at the pinned release (see [Ditto Action Tools](#ditto-action-tools)); it needs access to raw.githubusercontent.com once.

### Run (stdio transport)

The MCP server runs in stdio mode by default (for Claude Desktop, Cline, and other MCP clients):

```bash
# Development (with tsx)
npm run dev:stdio

# Production (built)
node dist/bin/stdio.js
```

### Connect to Claude Desktop

Add the server to Claude Desktop's MCP config:

```bash
claude mcp add ditto \
  -e DITTO_MCP_CONFIG=/absolute/path/to/config.json \
  -- node /absolute/path/to/ditto-mcp/dist/bin/stdio.js
```

Or edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) / `%APPDATA%\Claude\claude_desktop_config.json` (Windows) directly:

```json
{
  "mcpServers": {
    "ditto": {
      "command": "node",
      "args": ["/absolute/path/to/ditto-mcp/dist/bin/stdio.js"],
      "env": {
        "DITTO_MCP_CONFIG": "/absolute/path/to/config.json"
      }
    }
  }
}
```

### Run (HTTP transport)

The server can also run over HTTP (streamable SSE transport):

```bash
# Development
npm run dev:http

# Production
node dist/bin/http.js
```

By default, the HTTP server binds to `127.0.0.1:3000` and serves at `/mcp`. Configure via `server.http` in the config (see below).

## Docker Deployment

The HTTP transport is the intended production deployment: one long-lived container that MCP clients reach over a URL. The image bundles all native dependencies (`better-sqlite3`, `sqlite-vec`, `onnxruntime-node`) so consumers need no build toolchain. (stdio transport is for local development only.)

The repo ships a multi-stage `Dockerfile` and a baked default config at `docker/config.docker.json` (binds `0.0.0.0:3000`, sqlite index under `/app/data`, bearer auth reading `/run/secrets/mcp-token`).

### Build & run

```bash
docker build -t ditto-mcp-server:0.1.0 .

# The endpoint is authenticated; generate a token and mount it.
openssl rand -hex 32 > mcp-token

docker run -d -p 3000:3000 \
  -v ditto-data:/app/data \
  -v "$PWD/mcp-token:/run/secrets/mcp-token:ro" \
  ditto-mcp-server:0.1.0
```

The build is pinned: the base image by digest, dependencies by `package-lock.json` via `npm ci`, and onnxruntime's unused CUDA/TensorRT download is skipped. Building the same commit on the same CPU architecture therefore yields the same image contents. `docker build` targets the machine's own architecture — arm64 on Apple Silicon, amd64 on most Linux hosts and servers; to build one image for both, see [Publishing](#publishing-to-a-private-registry-eg-artifactory). To pick up a newer Node 22 or Debian security fixes, update `NODE_IMAGE` in the `Dockerfile` to the current digest (`docker buildx imagetools inspect node:22-slim`) and rebuild.

Point your MCP client at the HTTP endpoint, passing the token:

```json
{
  "mcpServers": {
    "ditto": {
      "url": "http://your-host:3000/mcp",
      "headers": { "Authorization": "Bearer <contents of mcp-token>" }
    }
  }
}
```

### ⚠️ Required: authenticate the endpoint

**`/mcp` is unauthenticated unless you configure `server.http.auth`.** Anyone who can reach the port can open a session and invoke every registered tool — and because every Ditto call uses the server's own `ditto.credential` / `ditto.devopsCredential`, an anonymous caller is executed *as the server's identity*. With a devops credential configured that reaches `/devops/*` and the secret-bearing `/api/2/connections*`, whose responses contain connection URIs with embedded passwords.

To make that hard to do by accident, the server **refuses to start** when `server.http.auth.mode` is `none` and `server.http.host` is not a loopback address:

```
[ditto-mcp] fatal: server.http.host is '0.0.0.0' but server.http.auth.mode is 'none': the /mcp
endpoint would accept unauthenticated requests. Set server.http.auth (mode: "bearer", with token
or tokenFile), or bind to 127.0.0.1.
```

`allowedHosts` / DNS-rebinding protection is **not** access control — it is a `Host`-header check that stops a browser-driven rebinding attack. An attacker sending an allowed `Host` passes it. Use it in addition to `auth`, never instead of it.

Bearer auth compares the presented token against `token` or `tokenFile` using a constant-time digest comparison:

```json
{
  "server": {
    "http": {
      "auth": { "mode": "bearer", "tokenFile": "/run/secrets/mcp-token" }
    }
  }
}
```

The token only grants access to this MCP server. It never reaches Ditto: the server calls Ditto **only as itself**, with `ditto.credential` (or `ditto.devopsCredential` for sudo operations), whatever headers the caller sent. Clients never need a Ditto credential, so an all-OAuth setup needs no extra headers — the server runs both client-credentials grants and refreshes both tokens itself.

A single shared secret gives you one bearer identity for every caller — fine for a sidecar or a single operator, not a substitute for per-user identity. OIDC bearer validation (validate the caller JWT, then forward it to Ditto so Ditto's policy engine authorizes per-thing) is the intended follow-up.

### ⚠️ Required: set `allowedHosts` for your hostname

The baked config keeps DNS rebinding protection **on**, with `allowedHosts` limited to `localhost:3000` / `127.0.0.1:3000`. A request whose `Host` header is not on that list is rejected with **HTTP 403 `Invalid Host header`** — so a container reached via a service name, public hostname, or reverse proxy is unreachable until you add that host.

Override the config with your real hostname (see the [Server HTTP options](#server-http-transport-options) table):

```json
{
  "server": {
    "http": {
      "host": "0.0.0.0",
      "port": 3000,
      "enableDnsRebindingProtection": true,
      "allowedHosts": ["ditto-mcp.internal:3000", "mcp.example.com"]
    }
  }
}
```

Mount it and point the server at it:

```bash
docker run -d -p 3000:3000 \
  -v ditto-data:/app/data \
  -v /path/to/config.json:/app/config.docker.json:ro \
  ditto-mcp-server:0.1.0
```

Disabling `enableDnsRebindingProtection` is only appropriate when the container sits behind a proxy or network boundary that validates the `Host` header for you — do not ship it disabled on a directly exposed service.

### Publishing to a private registry (e.g. Artifactory)

Artifactory (and most registries) host Docker images directly — no npm publish needed.

```bash
docker login your.artifactory.com                 # user + API token
docker buildx build --platform linux/amd64,linux/arm64 \
  -t your.artifactory.com/docker-local/ditto-mcp-server:0.1.0 --push .
```

This publishes one tag for both architectures, so it runs on amd64 servers and Apple Silicon alike; the half that doesn't match the building machine runs emulated (Docker Desktop includes the emulation; on Linux, register it once with `docker run --privileged --rm tonistiigi/binfmt --install arm64`). Consumers then `docker run your.artifactory.com/docker-local/ditto-mcp-server:0.1.0`.

### Vector / hybrid retrieval in containers

The default `retriever: fts` needs no embedding model. If you switch to `vector` or `hybrid`, the bge model is downloaded at runtime from the Hugging Face Hub — which fails in air-gapped networks. For offline use, either bake the model into the image and set `knowledge.embedding.modelPath`, or mount a pre-populated cache and set `knowledge.embedding.cacheDir`. Persist the built index with the ingest process (see below) so the container doesn't rebuild in memory on every start.

## Two Processes: Ingest vs. Server

The MCP server supports **persistent knowledge indexes** (SQLite or Postgres). The index must be built **before** the server starts (or the server falls back to building it in memory at startup).

- **Ingest process** (`ditto-mcp-ingest` or `npm run dev:ingest`) — builds and persists the knowledge index (fetch → chunk → embed → write to store). Run this once, or whenever your corpus changes.
- **Server process** (`ditto-mcp-stdio` / `ditto-mcp-http`) — serves MCP tools. Reads the prebuilt index if it exists and is valid; otherwise builds in memory (SQLite), or starts with knowledge tools disabled and logs a warning until the index has been ingested and the server restarted (Postgres).

**When to run ingest:**

- After changing `knowledge.retriever`, `knowledge.embedding.model`, or `knowledge.embedding.dim` (metadata mismatch requires a rebuild).
- After adding/removing sources (`publicSource`, `localDir`).
- When you want to persist the index to disk (SQLite) or Postgres (pgvector).

**Ingest command:**

```bash
DITTO_MCP_CONFIG=/path/to/config.json npm run dev:ingest  # development
DITTO_MCP_CONFIG=/path/to/config.json ditto-mcp-ingest    # production
```

The ingest command reads `knowledge.store` from your config and writes the index to the configured location (SQLite file path or Postgres connection). If the config specifies `kind: "sqlite"` but no `sqlite.path`, ingest will error (it requires an explicit path to write to).

**Strict by default:**

Ingest fails if any item fails to load, so it never writes a partial index. An item fails to load when:
- a configured local directory is missing or unreadable
- a configured local directory contains no markdown files (deliberate: a Docker volume that did not mount shows up as an empty directory)
- a local file cannot be read
- a document listed in `llms.txt` fails to download

Links in `llms.txt` that are not to markdown documents are ignored, and so are malformed links (with a warning on stderr): neither counts as a failed item, since re-running cannot fix them.

If an ingest fails, the existing index is left unchanged.

```bash
# Skip individual failed items and build with the rest
npm run dev:ingest -- --force  # development
ditto-mcp-ingest --force       # production
```

`--force` builds without items that fail to load (skipped items are logged). However, ingest always fails, even with `--force`, on:
- Sources that share the same id
- Duplicate chunk ids across sources
- Zero chunks loaded from all sources
- A source that fails entirely: an `llms.txt` that cannot be fetched or contains no markdown links

**SQLite notes:**

- Concurrent ingests on the same path are safe: each builds into a `*.tmp` file, and the last one to finish wins.
- A killed ingest may leave `*.tmp` / `*.tmp-journal` files next to the index (clean them up manually).

## Configuration

All configuration is optional. The server uses sensible defaults when no config is provided. Pass a JSON config file via the `DITTO_MCP_CONFIG` environment variable.

See `examples/` for reference configs. All examples are parse-tested in CI and won't rot.

### Server (HTTP transport options)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `server.name` | `string` | `"ditto-mcp"` | Server name exposed to MCP clients |
| `server.http.port` | `number` | `3000` | HTTP server port |
| `server.http.host` | `string` | `"127.0.0.1"` | Bind address (loopback by default) |
| `server.http.enableDnsRebindingProtection` | `boolean` | `true` | Enable DNS rebinding protection (rejects requests with invalid Host/Origin headers) |
| `server.http.allowedHosts` | `string[]?` | `undefined` | Allowed Host header values (e.g., `["mcp.example.com:3000"]`). When undefined and protection is enabled, a loopback allowlist is derived: `["127.0.0.1:port", "localhost:port", "[::1]:port", "host:port"]` |
| `server.http.allowedOrigins` | `string[]?` | `undefined` | Allowed Origin header values (optional) |
| `server.http.sessionIdleTimeoutMs` | `number` | `1800000` (30 min) | Close an MCP session with no request in flight for this long. A client holding its event stream open is never idle. Its next request gets 404, and spec-compliant clients then re-initialize |
| `server.http.maxSessions` | `number` | `100` | Session cap. At the cap, a new session closes the least recently active idle one (idle = no request in flight, so a client that only POSTs is idle between calls), or else a busy one inactive for longer than `sessionIdleTimeoutMs` (a stream to a vanished client may never close). A busy session that was recently active is never closed; if no session qualifies, the new `initialize` gets 503. With more concurrently active clients than the cap, they push each other out (each re-initializes on 404): raise the cap |
| `server.http.auth.mode` | `"none" \| "bearer"` | `"none"` | Authentication for the `/mcp` endpoint. `none` is rejected at startup on a non-loopback `host` |
| `server.http.auth.token` | `string?` | `undefined` | Shared bearer token (prefer `tokenFile`; inline secrets land in config files) |
| `server.http.auth.tokenFile` | `string?` | `undefined` | Path to a file holding the bearer token; trailing whitespace is trimmed |

**Remote deployments:** When binding a non-loopback host (e.g., `0.0.0.0` or a public IP), you **MUST** set both `server.http.auth` (the server refuses to start otherwise) and `allowedHosts` explicitly. The SDK matches the full `Host` header (e.g., `mcp.example.com:3000`), so include the exact `host:port` values your clients will send.

Example:
```json
{
  "server": {
    "http": {
      "host": "0.0.0.0",
      "port": 3000,
      "allowedHosts": ["mcp.example.com:3000"]
    }
  }
}
```

### Knowledge Tools

The server exposes `search` and `get_chunk` tools backed by a pluggable knowledge core. You can index:
- **Public Ditto docs** (fetched from `llms.txt` at startup, enabled by default)
- **Local markdown directory** (disabled by default)
- **Both** (merged corpus)

Choose a retriever mode:
- `fts` (default) — fast keyword search, no model download, works offline
- `vector` — semantic vector search (downloads BGE embedding model ~80MB on first run)
- `hybrid` — RRF fusion of FTS + vector (best recall)

The index can be stored in **SQLite** (file-based, default) or **Postgres** (pgvector + FTS).

#### Knowledge Config

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `knowledge.enabled` | `boolean` | `true` | Enable knowledge tools |
| `knowledge.retriever` | `"fts" \| "vector" \| "hybrid"` | `"fts"` | Retriever mode |

#### Sources

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `knowledge.publicSource.enabled` | `boolean` | `true` | Enable PublicSource (Ditto llms.txt) |
| `knowledge.publicSource.url` | `string` | `"https://eclipse.dev/ditto/llms.txt"` | llms.txt URL |
| `knowledge.publicSource.maxDocs` | `number?` | `undefined` | Optional doc limit |
| `knowledge.localDir.enabled` | `boolean` | `false` | Enable LocalDirSource (index local markdown directories) |
| `knowledge.localDir.paths` | `string[]?` | `undefined` | Paths to local markdown directories (each walked recursively) |
| `knowledge.localDir.id` | `string` | `"local"` | Source ID for local chunks |

#### Chunking

Controls how source markdown is split into indexed chunks. Applies to all sources (public + local). Re-run `ditto-mcp-ingest` after changing these to rebuild the index.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `knowledge.chunk.maxChars` | `number` | `1000` | Max characters per chunk. Larger = more contiguous context per hit, fewer split-across-boundary gaps; coarser ranking precision and more tokens returned per result. |
| `knowledge.chunk.overlap` | `number` | `150` | Characters carried between adjacent pieces when a paragraph is hard-split. Must be `< maxChars`. Raise to reduce boundary loss without growing chunks much. |

**⚠️ Ceiling for `vector`/`hybrid`:** the embedding model bounds useful chunk size. `bge-small-en-v1.5` has a **512-token (~1500–2000 char) window** — text beyond it is silently truncated before embedding, so a chunk larger than the window loses semantic recall on its tail. Keep `maxChars` at/under the model's window for vector search, or switch to a longer-context embedding model. For `fts` (no embeddings) there is no such limit; larger chunks are safe.

#### Search (query-time)

Applies at search time — no re-ingest needed. The `search` tool accepts per-call `limit` and `context` args that override these defaults.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `knowledge.search.limit` | `number` | `5` | Default number of **matches (anchors)** returned. Max 20. Neighbors from `context` do not count against it. |
| `knowledge.search.context` | `number` | `1` | **Neighbor expansion**: adjacent same-document chunks pulled in on each side of every match, for surrounding context. Max 5. `0` = matches only. |

**Neighbor expansion** decouples *retrieval granularity* from *context delivery*. The retriever finds the relevant chunk (anchor); expansion then fetches its positional neighbors (same document, adjacent ordinal) **by id — never re-scored or re-embedded**. This is retriever-agnostic: an `fts`, `vector`, or `hybrid` match all get the same neighbors, since neighbors are defined by document layout, not by how the anchor was found. Results are emitted as contiguous spans in reading order; neighbors are tagged `context` (vs. `matched: …`) so their relevance isn't over-weighted.

Why it matters for `vector`/`hybrid`: keep chunks **small** (sharp embeddings, under the 512-token ceiling) and recover surrounding context via `context` instead of fat chunks. Because neighbors are fetched by id, expansion never touches the embedding ceiling.

**Interaction with `chunk.overlap`:** overlap and neighbor expansion both fight boundary loss, so they partly overlap in purpose. With `context ≥ 1`, adjacent chunks are already returned — so a positive `overlap` duplicates the seam text. When using expansion, set `chunk.overlap` low or `0`.

Recommended for `hybrid`: small chunks + expansion, no overlap:

```json
{ "knowledge": {
  "retriever": "hybrid",
  "chunk":  { "maxChars": 1000, "overlap": 0 },
  "search": { "limit": 5, "context": 1 }
} }
```

#### Embedding (for vector/hybrid)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `knowledge.embedding.model` | `string` | `"Xenova/bge-small-en-v1.5"` | Hugging Face model ID |
| `knowledge.embedding.dim` | `number` | `384` | Embedding dimension (must match the model) |
| `knowledge.embedding.modelPath` | `string?` | `undefined` | Local path to ONNX model (offline mode) |
| `knowledge.embedding.allowRemoteModels` | `boolean` | `true` | Allow model download from Hugging Face |
| `knowledge.embedding.cacheDir` | `string?` | `undefined` | Custom cache directory for downloaded models |
| `knowledge.embedding.batchSize` | `number` | `32` | Embedding batch size |

**Offline vector search:** Set `allowRemoteModels: false` and provide `modelPath` pointing to a pre-downloaded ONNX model directory.

#### Store (persistence)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `knowledge.store.kind` | `"sqlite" \| "pgvector"` | `"sqlite"` | Store backend |
| `knowledge.store.sqlite.path` | `string?` | `undefined` | Path to SQLite file. If unset, the server builds an in-memory index at startup. |
| `knowledge.store.pgvector.connectionString` | `string?` | `undefined` | Postgres connection string (required when `kind: "pgvector"`) |
| `knowledge.store.pgvector.table` | `string` | `"ditto_kn"` | Table name prefix for Postgres tables (max 40 chars: letters, digits, `_`) |

**SQLite (default):** File-based index. If `sqlite.path` is set and the file exists, the server loads it instantly (no fetch/embed). If missing/corrupt/mismatched, the server builds the index in memory (fallback mode). The server never writes the file automatically — use `ditto-mcp-ingest` to persist.

**Postgres (pgvector):** Requires the `vector` extension. If the index exists and metadata matches, the server loads instantly. If missing or mismatched, the server starts with knowledge tools disabled and logs a warning (no in-memory fallback). You **must** run `ditto-mcp-ingest` to populate Postgres, then (re)start the server to enable knowledge tools. Ingest builds the index into staging tables (`${table}_staging_*`) and swaps them into the live prefix in one transaction. A failed ingest leaves the live index untouched. A server already serving the index sees a re-ingested index right after the swap (no restart needed), checked against its config like at startup: if the new index was built for another retriever or with another embedding model or dim, `search` is refused with the reason (and a `knowledge search disabled` log line) until an ingest that matches again. A second concurrent ingest on the same table fails fast with an error.

Roles: only ingest creates tables, so the ingest role needs `CREATE` on the schema. The server only reads, so a serving role needs nothing beyond `USAGE` on the schema and `SELECT` on `${table}_chunks`, `${table}_meta` and `${table}_vec` (without `USAGE`, the tables look missing). If the tables don't exist yet, the server logs which ones are missing and starts with knowledge tools disabled. Grant once after the first ingest: the swap copies the live tables' grants onto the tables it swaps in, and a first `${table}_vec` (e.g. switching from `fts` to `hybrid`) gets the grants of `${table}_chunks`.

Operational caveat: the ingest lock is a session-level advisory lock, so ingest needs a direct or session-pooled connection, not PgBouncer transaction pooling. If the lock's session drops mid-ingest (idle timeout, failover), the ingest fails without changing the live index; re-run it.

**Postgres setup (AWS RDS example):**
1. Create a Postgres database.
2. Enable the `vector` extension:
   - Create a custom parameter group with `rds.extensions = 'vector'`
   - Apply it to your instance
   - Connect and run `CREATE EXTENSION IF NOT EXISTS vector;`
3. Configure `knowledge.store.pgvector.connectionString` in your config.
4. Run `ditto-mcp-ingest` to build the index.

**Testing Postgres:** Run `npm run test:pg` (requires Docker + testcontainers). These tests are excluded from the default `npm test` suite to keep the default test run hermetic.

### Ditto Action Tools

The server can expose action tools dynamically generated from a Ditto OpenAPI spec. Each tool makes HTTP calls to a Ditto instance with the server's own configured credentials, never the caller's (see [Credentials](#credentials)); Ditto authorizes that identity, and the policy below decides which operations are exposed at all. The default policy is **read-only** (`GET` only).

#### Ditto Config

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `ditto.enabled` | `boolean` | `false` | Enable action tools |
| `ditto.baseUrl` | `string` | (required if enabled) | Base URL to Ditto instance (e.g., `http://localhost:8080`) |
| `ditto.openApi.path` | `string?` | `undefined` | Path to a local OpenAPI spec file. |
| `ditto.openApi.url` | `string?` | `undefined` | URL to fetch the OpenAPI spec from. |
| `ditto.openApi.version` | `string?` | `undefined` | Ditto git tag/ref (e.g. `3.6.0`) to fetch the matching spec for, via `versionUrlTemplate`. |
| `ditto.openApi.versionUrlTemplate` | `string` | eclipse-ditto raw URL | URL template with a `${version}` placeholder; override for forks/mirrors. |

Spec resolution precedence (first match wins): `path` > `url` > `version` > the bundled spec (`openapi/ditto-api-2.yml`, Ditto's spec at the release pinned in `openapi/ditto-spec.json`), which is baked into the Docker image and works offline. The bundled spec is not checked in: `npm run fetch-spec` downloads it and verifies its sha256, and `npm test`, `npm run build`, `npm run dev:stdio`, `npm run dev:http` and the Docker build run it first. See `openapi/README.md` for offline setup and for moving the pin. Set `version` to target a different Ditto release at runtime (requires network).

The action tools are built once at startup. With `ditto.enabled: true`, a spec that cannot be loaded (unreachable URL, bad file) or a missing `ditto.baseUrl` stops the server with a `fatal:` error naming the cause, instead of it running without action tools until the next restart.

#### Credentials

Action tools support two credential modes:

| Kind | Description |
|------|-------------|
| `basic` | Username + password (sent as `Authorization: Basic <base64(user:pass)>`) |
| `oidc` | OAuth2 client-credentials flow: requests a token from `tokenUrl` using `clientId` + `clientSecret`, sends it as `Authorization: Bearer <token>`, auto-refreshes ~30s before expiry |

**OIDC credential fields:**
- `tokenUrl` (required) — OAuth2 token endpoint
- `clientId` (required) — OAuth2 client identifier
- `clientSecret` (required) — OAuth2 client secret (never logged)
- `scope` (optional) — OAuth2 scopes (space-separated)

Example:
```json
{
  "ditto": {
    "enabled": true,
    "baseUrl": "http://localhost:8080",
    "credential": {
      "kind": "oidc",
      "tokenUrl": "https://auth.example.com/oauth/token",
      "clientId": "my-client-id",
      "clientSecret": "my-client-secret",
      "scope": "ditto:read ditto:write"
    }
  }
}
```

**Standard vs devops credentials:**

`ditto.credential` authenticates standard operations. `ditto.devopsCredential` (optional, same shape) authenticates **sudo** operations — `/devops/*`, `sudo*`, and the secret-bearing connectivity API (`/api/2/connections*`).

- Sudo operations use `devopsCredential` **exclusively**. If `devopsCredential` is not set, every sudo tool is refused at the MCP layer (even if `credential` could reach it).
- `devopsCredential` may be `basic` (Ditto `DevOpsBasic`: a devops user's username/password) or `oidc` (Ditto `DevOpsBearer`: OAuth2). For a separate devops OIDC identity, give it its own `clientId`/`clientSecret`.
- Callers cannot supply or override either credential. Any `Authorization` header a caller sends is ignored for Ditto calls.

Example (separate OIDC identities):

```json
{
  "ditto": {
    "enabled": true,
    "baseUrl": "http://localhost:8080",
    "credential":       { "kind": "oidc", "tokenUrl": "https://idp/token", "clientId": "app",    "clientSecret": "..." },
    "devopsCredential": { "kind": "oidc", "tokenUrl": "https://idp/token", "clientId": "devops", "clientSecret": "..." },
    "policy": { "sudoAllowlist": ["GET /api/2/connections"] }
  }
}
```

**Migration from earlier configs:** the `devops` credential kind and the `devops: true` flag are removed. Move a devops credential into `ditto.devopsCredential` (use `kind: "basic"` for a devops username/password).

**Authorization enforcement:** Ditto enforces access control for the server's own identity: `ditto.credential`, or `ditto.devopsCredential` for sudo operations. A caller's credentials or `Authorization` header are never forwarded, so every MCP client acts with that identity's Ditto permissions; scope it accordingly. The policy below can only narrow which operations are exposed. Credentials are never logged.

#### Policy

By default, action tools only expose **read** (`GET`) operations. Write and privileged operations require explicit allowlisting:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `ditto.policy.allowMethods` | `string[]` | `["GET"]` | Wholesale HTTP method allowlist (applies to all non-sudo operations) |
| `ditto.policy.writeAllowlist` | `string[]` | `[]` | Per-operation granular allowlist for enabling specific write operations (see key format below) |
| `ditto.policy.sudoAllowlist` | `string[]` | `[]` | Per-operation allowlist for sudo/devops-privileged operations (see key format below) |

**Allowlist key format:** each entry is either the OpenAPI `operationId` (e.g. `putThing`) **or** a `METHOD path` key (e.g. `PUT /api/2/things/{thingId}`). Ditto's OpenAPI spec does not declare `operationId`s, so use the `METHOD path` form — the `path` is the raw spec path, keeping the `{param}` braces. `allowMethods` (wholesale, non-sudo) is unaffected.

**Sudo operations & devops credential:**

Ditto secures `/api/2/connections*` (secret-bearing) with `DevOpsBasic`/`DevOpsBearer` security, and `/devops/*` paths are devops-privileged. These operations are classified as "sudo" and:
- Must be explicitly listed in `sudoAllowlist` (by `METHOD path` key, or operationId if the spec has one)
- Require `ditto.devopsCredential` to be configured.
- Are NOT auto-allowed even if the method is `GET` and in `allowMethods`.

Connectivity is always devops-gated (classified sudo regardless of the OpenAPI spec's declared security), but policy granularity is unchanged — `sudoAllowlist` is a per-operation opt-in (default `[]` = all sudo blocked). Allow connections while blocking direct-actor/devops commands by listing only the connection operations:

- Connections read only: `"sudoAllowlist": ["GET /api/2/connections", "GET /api/2/connections/{connectionId}"]`
- Full connections CRUD, still blocking piggyback/devops: `"sudoAllowlist": ["GET /api/2/connections","GET /api/2/connections/{connectionId}","POST /api/2/connections","PUT /api/2/connections/{connectionId}","DELETE /api/2/connections/{connectionId}"]`

All sudo operations still require `ditto.devopsCredential` to be set.

**Examples:**

- **Read-only (default):** `{ "allowMethods": ["GET"] }` — only non-sudo GET operations are allowed.
- **Enable specific writes:** `{ "allowMethods": ["GET"], "writeAllowlist": ["PUT /api/2/things/{thingId}", "PATCH /api/2/things/{thingId}"] }` — enables specific write operations.
- **Enable sudo:** `{ "allowMethods": ["GET"], "sudoAllowlist": ["GET /api/2/connections", "GET /devops/logging"] }` — enables specific devops-privileged operations (requires devops credential).

### Tools Exposed

When running, the server exposes:

**Core tools:**
- `ping` — health check (enabled by default via `tools.ping`; independent of `knowledge`/`ditto`)

**Knowledge tools (if `knowledge.enabled: true`):**
- `search` — semantic/keyword search over the knowledge corpus
- `get_chunk` — retrieve a specific chunk by ID

**Action tools (if `ditto.enabled: true`):**

Dynamically generated from the Ditto OpenAPI spec. Every action tool name starts with `ditto_`, so a spec operation can never shadow a core or knowledge tool. Ditto's spec declares no `operationId`s, so names are built from the method and path, without the `/api/2` prefix and keeping only a trailing path parameter (the tool description always carries the full `METHOD path`). Examples:
- `ditto_GET_things_thingId`, `ditto_PUT_things_thingId`, `ditto_PATCH_things_thingId`, `ditto_DELETE_things_thingId`
- `ditto_GET_policies_policyId`, `ditto_PUT_policies_policyId`, `ditto_DELETE_policies_policyId`
- `ditto_GET_connections`, `ditto_POST_connections`, `ditto_DELETE_connections_connectionId` (sudo, requires devops credential + `sudoAllowlist`)
- `ditto_POST_devops_piggyback` (sudo)

A spec that does declare `operationId`s gets `ditto_<operationId>`. Names are capped at 64 characters; a longer one is cut and ends in a short hash of its operation, so names stay distinct.

Write tools (POST, PATCH, PUT) expose their top-level request body fields in the tool schema, allowing clients to discover and validate the shape of the request. Nested objects are passed through as freeform JSON.

## Security & OSS Notes

**Commit the engine, NOT your corpus/built index/secrets:**

- The built knowledge index (`.db` files) is gitignored. Commit the code, not the index.
- Local corpus directories (markdown files) may contain proprietary content — do NOT commit them to public repos unless intended.
- Credentials in `config.local.json` or other configs may contain secrets — do NOT commit them. Use environment variables or secret managers in production.
- Downloaded embedding models (`models/`, `.cache/`) are gitignored.

**Server-held credentials:**

The MCP calls Ditto only with its own configured credentials (`ditto.credential`, and `ditto.devopsCredential` for sudo); caller-supplied credentials are never forwarded. Ditto enforces authorization for that identity, and the MCP adds policy gating on top (allowMethods, writeAllowlist, sudoAllowlist). Credentials are never logged by the server.

**Read-only default:**

The default policy (`allowMethods: ["GET"]`) ensures action tools are read-only unless you explicitly enable writes. Sudo operations (connections, devops) require explicit `sudoAllowlist` + devops credential.

**Sudo/devops/connections gating:**

Connections and devops endpoints are gated at the MCP layer (sudo policy) to prevent accidental exposure of secret-bearing APIs. Ditto still enforces the real authorization.

## Testing

```bash
npm test              # hermetic unit tests (no Docker, no network; first fetches the pinned Ditto spec if missing)
npm run test:pg       # Postgres integration tests (requires Docker + testcontainers)
npm run typecheck     # TypeScript type check
```

The examples are parse-tested in `src/config/examples.test.ts` to ensure they stay valid.

## Examples

See `examples/` for reference configs:

- `public-fts.json` — simplest public quickstart (FTS, SQLite, llms.txt only)
- `hybrid-local.json` — hybrid retriever + local markdown directory + llms.txt
- `pgvector.json` — Postgres (pgvector) store for persistent index
- `ditto-readonly.json` — Ditto action tools with read-only policy (basic auth)
- `ditto-oidc-write.json` — Ditto action tools with OIDC client-credentials + write/sudo operations

All examples use placeholders (e.g., `REPLACE_ME`, `/path/to/...`) for secrets and paths. Replace these with your own values before use.

## Project Layout

- `src/core/` — shared types (`ToolDef`, `RequestCtx`)
- `src/registry/` — `ToolRegistry`
- `src/config/` — zod schema + loader
- `src/tools/` — tool implementations (`ping`, `search`, `get_chunk`) + wiring
- `src/knowledge/` — corpus/retrieval core (`KnowledgeSource`, `Retriever`, `PublicSource`, `LocalDirSource`, `FtsRetriever`, `VectorRetriever`, `HybridRetriever`)
- `src/ditto/` — action tools (OpenAPI → MCP tool schema, credential handling, policy enforcement)
- `src/server/` — `buildServer`, `createHttpApp`
- `src/bin/` — `stdio`, `http`, `ingest` entrypoints
- `examples/` — reference configs (parse-tested)
- `openapi/` — pin (Ditto ref + sha256) of the bundled Ditto spec; `scripts/fetch-ditto-spec.mjs` downloads it

## Dependencies

- `@modelcontextprotocol/sdk` — MCP protocol
- `express` — HTTP server
- `zod` — config validation
- `better-sqlite3` — SQLite store
- `pg` — Postgres client (pgvector store)
- `sqlite-vec` — SQLite vector extension
- `@huggingface/transformers` — ONNX embedding models
- `yaml` — OpenAPI spec parsing
