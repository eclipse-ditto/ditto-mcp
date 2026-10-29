# AGENTS.md: ditto-mcp

Instructions for coding agents working on this repo, following the [AGENTS.md](https://agents.md) convention.

ditto-mcp is an MCP (Model Context Protocol) server for Eclipse Ditto. TypeScript, ESM, Node >= 22, EPL-2.0.

It exposes three kinds of tool:
- `ping`: a health check.
- `search` / `get_chunk`: keyword (FTS), vector, or hybrid search over the Ditto docs (public `llms.txt`) plus optional local markdown.
- `ditto_*` action tools: generated at startup from Ditto's OpenAPI spec, filtered by a policy, and calling Ditto with credentials the server holds.

There are three processes: `stdio` (local use), `http` (production, Docker), and `ingest` (a separate CLI that builds the persistent knowledge index).

**Look things up in this file and in `.claude/rules/` before searching the tree.** The code map below lists every source file. Each rule in `.claude/rules/` covers one area, and its `paths:` frontmatter says which files it applies to. Claude Code loads a rule automatically when it touches a matching file. Other agents: before editing a file, read every rule that matches it (see the [rules index](#rules-index-clauderules) at the end). `.claude/rules/git-workflow.md` applies to every change.

## Commands

| Task | Command |
|---|---|
| Install | `npm ci` |
| Typecheck | `npm run typecheck` |
| Unit tests (hermetic: no network, no Docker) | `npm test` |
| Fetch the bundled Ditto spec (`npm test`, `build`, `dev:stdio`, `dev:http` run it first) | `npm run fetch-spec` |
| One file / one test (skips `fetch-spec`) | `npx vitest run src/ditto/client.test.ts` / `npx vitest run -t "<test name>"` |
| Postgres tests (Docker + testcontainers) | `npm run test:pg` |
| Build to `dist/` | `npm run build` |
| Run from source | `DITTO_MCP_CONFIG=<file> npm run dev:stdio` (or `dev:http`, `dev:ingest`) |
| Docker image | `docker build -t ditto-mcp-server:0.1.0 .` |

A change is done when `npm run typecheck && npm test` passes. If you touched Postgres or ingest code, `npm run test:pg` must pass too. CI (`.github/workflows/build.yml`) runs all three.

## Startup flow

```
bin/stdio.ts, bin/http.ts
  loadConfig(DITTO_MCP_CONFIG)         config/load.ts      zod-parsed AppConfig; no file means all defaults
  buildKnowledgeService(config)        knowledge/build.ts  KnowledgeService | undefined (never fails startup)
  registerTools(config, knowledge)     tools/index.ts      ToolRegistry, built ONCE and shared
    pingTool, makeKnowledgeTools(), makeActionTools() (lazy import; throws, which stops startup)
  stdio: buildServer(registry) + StdioServerTransport
  http:  createHttpApp(config, registry); one McpServer + transport per session
bin/ingest.ts
  makeSources() + makeEmbedder()  ->  withIngestStore(config, store => buildIndex(...))
```

## Code map (`src/`)

| File | Responsibility / key exports |
|---|---|
| `core/types.ts` | `ToolDef`, `ToolResult`, `textResult()`, `RequestCtx` {config, sessionId, headers, signal} |
| `registry/tool-registry.ts` | `ToolRegistry`: name to ToolDef map; throws on a duplicate name |
| `config/schema.ts` | `AppConfigSchema` (zod 3): every option and default; `AppConfig`, `CredentialConfig`, `HttpAuthConfig` |
| `config/load.ts` | `loadConfig(path?)` |
| `tools/index.ts` | `registerTools()`: decides which tools get registered |
| `tools/ping.ts` | `pingTool` |
| `tools/knowledge.ts` | `makeKnowledgeTools()`: `search` / `get_chunk` schemas, descriptions, output format |
| `server/build-server.ts` | `buildServer()`: ToolRegistry to SDK `McpServer`; version read from package.json; `_init` placeholder |
| `server/request-ctx.ts` | `buildCtx()`: the SDK's `extra` argument to `RequestCtx` |
| `server/http-app.ts` | `createHttpApp()`: Express `/mcp` POST/GET/DELETE, bearer gate, loopback fail-closed check, Host allowlist, session routing |
| `server/session-table.ts` | `SessionTable`: session cap, idle sweep, two-phase reserve/add admission, eviction |
| `bin/stdio.ts`, `bin/http.ts`, `bin/ingest.ts` | Entrypoints: `main().catch` prints `fatal:` and exits 1 |
| `ditto/openapi.ts` | `parseOperations(spec)` returns `DittoOperation[]`: `$ref` resolution, params, body media type, body schema, `MERGE_PATCH`, `mediaType()` |
| `ditto/tool-policy.ts` | `isSudo(op)`, `isAllowed(op, policy)` |
| `ditto/action-tool.ts` | `toolName()` (`ditto_` prefix, 64-char cap + hash), zod input schema, `operationToTool()` (picks the credential) |
| `ditto/action-tools.ts` | `makeActionTools()`: spec resolution, credentials, policy filter, name de-dup; `BUNDLED_SPEC_PATH` |
| `ditto/client.ts` | `HttpDittoClient.execute()`: builds the URL, guards path params, encodes the body |
| `ditto/credential.ts` | `DittoCredential`, `createConfigCredential()`, `OidcClientCredential` (client-credentials grant, token cache, shared fetch) |
| `ditto/fake-ditto.ts`, `ditto/fake-oidc.ts` | Test-only HTTP fakes |
| `knowledge/types.ts` | `Chunk`, `RetrievedChunk`, `KnowledgeSource`, `Retriever`, `SkipFn`, `SkippedItem` |
| `knowledge/knowledge-store.ts` | `KnowledgeStore` interface, `IndexMeta`, `SCHEMA_VERSION`, `ftsTokens()` |
| `knowledge/sqlite-knowledge-store.ts` | `SqliteKnowledgeStore`: better-sqlite3 + FTS5 + sqlite-vec |
| `knowledge/pg-knowledge-store.ts` | `PgKnowledgeStore`: tsvector + pgvector HNSW; `connect`, `lockIngest`, `swapIntoLive`, `copyGrants` |
| `knowledge/store-factory.ts` | `openStore()`, `importPgStore()`: lazy imports of the native backends |
| `knowledge/ingest-store.ts` | `withIngestStore()`: atomic write (SQLite: tmp file + rename; pg: lock + staging tables + swap) |
| `knowledge/build-index.ts` | `buildIndex()`: validates, then writes chunks, vectors, meta; `metaFor()` |
| `knowledge/build.ts` | `buildKnowledgeService()`: whether to serve the prebuilt index, build in memory, or disable; `watchIndex`, `makeRetriever` |
| `knowledge/knowledge-service.ts` | `KnowledgeService`: search plus neighbor (context) expansion; `getChunk` |
| `knowledge/fts-retriever.ts`, `vector-retriever.ts`, `hybrid-retriever.ts` | Retrievers; hybrid fuses with RRF (k=60) |
| `knowledge/chunker.ts` | `chunkMarkdown()`, `docKey()`; defines the chunk id format |
| `knowledge/embedding.ts` | `EmbeddingProvider`, `LocalEmbeddings` (Transformers.js / ONNX), `toBatches()` |
| `knowledge/factories.ts` | `makeSources()`, `makeEmbedder()` (lazy import) |
| `knowledge/public-source.ts` | `PublicSource`: llms.txt to markdown docs |
| `knowledge/local-dir-source.ts` | `LocalDirSource`: recursive `.md` walk |
| `knowledge/ingest-error.ts` | `IngestError`, `errorReason()` (`errorReason` is shared by every module) |
| `knowledge/pg-testcontainer.ts` | Test-only `startPgVector()` |

Outside `src/`:
- `openapi/ditto-spec.json`: the Ditto git ref and sha256 of the bundled spec. `scripts/fetch-ditto-spec.mjs` (`npm run fetch-spec`) downloads it to `openapi/ditto-api-2.yml`, which is gitignored; never commit or hand-edit that file. See `openapi/README.md`.
- `examples/*.json`: reference configs, parse-tested by `src/config/examples.test.ts`.
- `docker/config.docker.json`: the config baked into the image. It is parse-tested, and a test asserts it keeps bearer auth.
- `Dockerfile`, `.github/workflows/build.yml`.
- `README.md`: the user docs and config reference tables.

## Where to change what

| Change | Edit | Also |
|---|---|---|
| Add a core tool | new `src/tools/<name>.ts`, registered in `tools/index.ts` | The name must not start with `ditto_` |
| Add or change a config option | `config/schema.ts` | `load.test.ts`, the README table, `examples/` (checklist in `.claude/rules/config-and-docs.md`) |
| `search` / `get_chunk` arguments or output | `tools/knowledge.ts` | |
| Ranking or context expansion | `knowledge/*-retriever.ts`, `knowledge/knowledge-service.ts` | |
| A new knowledge source | implement `KnowledgeSource`; wire it into `factories.ts` `makeSources` | Schema + README |
| A new store backend | implement `KnowledgeStore`; `store-factory.ts`, `ingest-store.ts`, `build.ts` | `store.kind` in the schema |
| What the server does with a prebuilt index | `knowledge/build.ts` | |
| Ingest behavior | `bin/ingest.ts`, `knowledge/build-index.ts`, `knowledge/ingest-store.ts` | README "Two Processes" section |
| Action tool names | `ditto/action-tool.ts` `toolName` | README "Tools Exposed" |
| Which operations are exposed / count as sudo | `ditto/tool-policy.ts` | `.claude/rules/security.md` |
| How requests to Ditto are built | `ditto/client.ts` | |
| OpenAPI parsing | `ditto/openapi.ts` | |
| Bundled Ditto spec version | `openapi/ditto-spec.json` | Steps in `openapi/README.md` |
| Ditto authentication | `ditto/credential.ts` | |
| HTTP routes, auth, status codes | `server/http-app.ts` | |
| Session cap, idle timeout, eviction | `server/session-table.ts` | |

## Golden rules

1. Never write to stdout: in stdio mode it carries the MCP frames. Log with `process.stderr.write("[ditto-mcp] ...\n")` (`[ditto-mcp ingest]` in the ingest CLI). Don't use `console.*`.
2. Ditto only ever sees the server's own identity: `ditto.credential`, or `ditto.devopsCredential` for sudo operations. Caller headers are never forwarded to Ditto and never pick the credential.
3. Fail closed. These stop startup: `auth.mode: "none"` on a non-loopback host; `ditto.enabled` without a `baseUrl`; a spec that can't be loaded. Knowledge problems never stop startup: the server logs them and serves without the knowledge tools.
4. The tool registry is built once at startup and shared. Only the `McpServer` and its transport are created per HTTP session.
5. Ingest never writes a partial or empty index. A failed ingest leaves the live index untouched.
6. Chunk ids `${source}:${sha256(cite)[0..12]}#${ordinal}` are a contract. `get_chunk` after a re-ingest and neighbor expansion both depend on the format.
7. Relative imports end in `.js` (NodeNext ESM). Every new `.ts`, YAML, or Dockerfile starts with the EPL-2.0 header.
8. Update `README.md` in the same commit as any change to behavior or config.
9. When you add, move, or rename a file, update the code map above.
10. This file and `.claude/rules/` are the only agent instructions. Don't add a project `CLAUDE.md`, `.claude/CLAUDE.md`, or `CLAUDE.local.md`: once one exists, Claude Code stops reading this file. (The `.claude/rules/` files keep loading either way.)

## Rules index (`.claude/rules/`)

| File | Applies when you touch | Covers |
|---|---|---|
| `git-workflow.md` | always | Commits, sign-off, CI, keeping these instructions current |
| `code-style.md` | `src/**/*.ts` | ESM/TS conventions, logging, errors, dependency injection, lazy imports, cancellation |
| `testing.md` | tests, fakes, vitest configs | Test suites, hermetic test patterns, fakes |
| `security.md` | `src/server`, `src/ditto`, `src/config`, `src/bin`, Docker | Credential model, HTTP auth, policy, path guard, SQL identifiers |
| `http-server.md` | `src/server`, `src/bin` | Transports, request flow, SessionTable invariants |
| `ditto-actions.md` | `src/ditto`, `openapi/`, `scripts/fetch-ditto-spec.mjs` | The OpenAPI-to-tool pipeline, naming, client, credentials |
| `knowledge.md` | `src/knowledge`, `tools/knowledge.ts`, `bin/ingest.ts` | Abstractions, chunk ids, index meta, server startup, ingest, stores |
| `config-and-docs.md` | `src/config`, `examples`, `docker`, `README.md`, `Dockerfile`, `package.json` | Config change checklist, Docker, dependencies |
