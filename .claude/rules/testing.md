---
paths:
  - "src/**/*.test.ts"
  - "src/**/*.pgtest.ts"
  - "src/**/*.itest.ts"
  - "src/**/fake-*.ts"
  - "src/knowledge/pg-testcontainer.ts"
  - "vitest*.ts"
---

# Testing

The framework is vitest 2 with `globals: false`: import `describe`, `it`, `expect`, and `vi` from `"vitest"` explicitly. Tests sit beside the code (`foo.ts` has `foo.test.ts`).

## Suites

| Suffix | Run by | Needs |
|---|---|---|
| `*.test.ts` | `npm test` (20 s timeout) | Nothing. Hermetic: no network, no Docker. (`npm test` first runs `fetch-spec`, which downloads the pinned Ditto spec only if `openapi/ditto-api-2.yml` is missing or stale; `npx vitest run` skips that step.) |
| `*.itest.ts` | `npm test`, but skipped unless an env var is set | e.g. `RUN_EMBED_ITEST=1` downloads the real bge model |
| `*.pgtest.ts` | `npm run test:pg` (`vitest.pg.config.ts`, 120 s timeouts) | Docker. `startPgVector()` from `knowledge/pg-testcontainer.ts` starts `pgvector/pgvector:pg16` |

To run a single file: `npx vitest run <file>`. For a pg file, add `--config vitest.pg.config.ts`.

## Keeping unit tests hermetic
- `*.test.ts` never touches the real network. Use the fakes and the injection points instead:
  - `startFakeDitto(handler)` (`ditto/fake-ditto.ts`): a real HTTP server on `127.0.0.1:0` that records method, url, auth, content-type, and body.
  - `startFakeOidc(token)` (`ditto/fake-oidc.ts`): a token endpoint that counts calls.
  - `fetchFn` for `PublicSource` and for `buildKnowledgeService` (through `FactoryDeps`); `loadSpec` and `client` for `makeActionTools`; `fetchFn` for `HttpDittoClient` and `OidcClientCredential`; `now` for `SessionTable`.
  - A fake embedder: `{ dim: 3, embed: async (t) => t.map(() => [1, 0, 0]) }`, together with `knowledge: { embedding: { dim: 3 } }` in the config.
- SQLite tests use `":memory:"`, or a file under `mkdtempSync(join(tmpdir(), "..."))`.
- HTTP tests listen with `app.listen(0)` and read the port back. For protocol end-to-end tests, drive the server with the SDK's real `Client` + `StreamableHTTPClientTransport`. For status and header checks, use raw `node:http` `request`.
- Don't mock modules with `vi.mock`. To assert on log lines, use `vi.spyOn(process.stderr, "write")` and restore it afterwards.
- Build configs with `AppConfigSchema.parse({ ...only what the test needs })`, so the defaults fill in the rest. Never hand-build an `AppConfig` object. With default config, `buildKnowledgeService` fetches the public llms.txt, so pass `knowledge: { enabled: false }` unless the test is about knowledge.
- Stop every server and container, and close every store, in `afterEach`, `afterAll`, or `finally`.

## Writing tests
- Test first: write a failing test that reproduces the bug or pins down the feature, then make it pass.
- Name the test after the behavior (`"refuses a sudo operation without a devops credential"`), not the function.
- When a regression test's scenario isn't obvious, say in a comment which failure it guards against.
- Postgres tests share one container per file. Each test creates its own table prefix (`t_${...}`) and connects with `{ staging: true }` when it needs a writable store, since only staging stores run DDL.
- `config/examples.test.ts` parses every `examples/*.json`, so a new example is picked up automatically. It also parses `docker/config.docker.json` and asserts it keeps bearer auth.
- `ditto/bundled-spec.test.ts` pins facts about the bundled spec (pinned in `openapi/ditto-spec.json`): there is a things GET; connections count as sudo; every PATCH is sent as merge-patch; tool names are distinct and at most 64 chars. After moving the pin, check those assumptions still hold.
- Test helpers that aren't `*.test.ts` (`fake-*.ts`, `pg-testcontainer.ts`) are compiled into `dist/` by `tsc`. Never import them from runtime code.
