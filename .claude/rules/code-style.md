---
paths:
  - "src/**/*.ts"
---

# TypeScript code style

Match the surrounding code. These conventions hold across `src/`.

## Modules and types
- ESM with `module: NodeNext`. Relative imports must end in `.js` (`import { x } from "./foo.js"`), even though the files are `.ts`.
- Use `import type` for type-only imports, and the `node:` prefix for built-ins (`node:fs`, `node:crypto`).
- Named exports only. `src/` has no default exports.
- `strict` is on. Runtime code has no `any`; freeform JSON in zod schemas uses `z.any()`. Tool handlers receive `args: unknown`, which the zod `inputSchema` has already validated, and cast it once (`args as { query: string }`).
- Contracts are interfaces (`KnowledgeStore`, `Retriever`, `KnowledgeSource`, `DittoClient`, `DittoCredential`, `EmbeddingProvider`), implemented by classes.
- Derive config types from the schema (`AppConfig`, `AppConfig["ditto"]["policy"]`). Never redeclare their shapes.

## License header
Every new `.ts` file starts with the EPL-2.0 block comment, copied verbatim from an existing file (`Copyright (c) 2026 Contributors to the Eclipse Foundation`). In `bin/*.ts` the `#!/usr/bin/env node` line comes first. YAML files and the Dockerfile carry the same text as `#` comments. Markdown and JSON files carry none.

## Logging
- Log only to stderr: `process.stderr.write("[ditto-mcp] ...\n")`. The ingest CLI's prefix is `[ditto-mcp ingest]`. Never use `console.*` or stdout: over stdio, stdout is the protocol stream.
- Never log credentials, tokens, client secrets, or response bodies from Ditto.

## Errors
- Write messages in lowercase, naming the config key and the fix: `"ditto.enabled is true but ditto.baseUrl is not set"`, `"knowledge.store.pgvector.connectionString is required"`.
- When you wrap an error, pass `{ cause: err }`, and format it with `errorReason(err)` from `knowledge/ingest-error.ts`. Node's fetch says only "fetch failed"; `errorReason` adds the `cause.code` (ECONNREFUSED, ENOTFOUND, TLS errors).
- `IngestError` means an ingest refused to write for a reason the operator can act on.
- Decide on purpose whether a problem should stop startup or degrade with a stderr warning. Ditto tools and HTTP auth stop startup (the error reaches `main().catch` in `bin/*`, which prints `fatal:`). Knowledge degrades: it falls back to building in memory, or disables itself.
- Tool handlers return `textResult(...)` (`core/types.ts`) for expected outcomes: not found, refused by policy, a non-2xx HTTP status from Ditto. They throw only on real failures; the SDK turns a throw into an error result.

## Dependency injection and lazy loading
- I/O comes in through optional parameters that default to the real thing: `fetchFn: typeof fetch = fetch`, `ActionToolDeps { loadSpec?, client? }`, `FactoryDeps { fetchFn?, embeddingProvider? }`, `now: () => number = Date.now`. Tests use these hooks; the codebase does no module mocking. Give new I/O the same kind of hook.
- Heavy and native dependencies load lazily, with `await import(...)` inside a try/catch that rethrows with a message naming the fix:
  - `@huggingface/transformers` in `factories.ts`
  - `better-sqlite3` / `sqlite-vec` and `pg` in `store-factory.ts`
  - the whole `ditto/` module in `tools/index.ts`

  `retriever: "fts"` must never load onnxruntime.
- Files that ship beside `dist/` (the bundled spec, `package.json`) are resolved from `import.meta.url`, two levels up. That path works from `src/` (tsx, vitest) and from `dist/` alike. Don't use `import ... with { type: "json" }` for files outside `rootDir`.

## Async, cancellation, network
- Pass `ctx.signal` (from `RequestCtx`) to every fetch or query a tool call starts.
- A shared in-flight promise (such as the OIDC token fetch) must not carry any one caller's signal. A caller that aborts stops waiting (`untilAborted`); the fetch itself keeps going for the others.
- Every outbound fetch has a timeout: `AbortSignal.timeout(15000)`, combined with any caller signal through `AbortSignal.any`.
- Never let a rejection go unhandled: attach handlers before any branch that can return early.
- Clean up on every path: close stores, pools, and clients in `try/finally`, and remove temp files on failure.

## Comments
Comments explain why: the constraint, the attack, the spec clause, the failure that was seen. Don't narrate what the code does. When you edit nearby code, keep the existing explanatory comments; they record decisions, and the commit bodies in `git log` tell the rest of the story.
