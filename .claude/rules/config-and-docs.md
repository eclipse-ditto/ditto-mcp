---
paths:
  - "src/config/**"
  - "examples/**"
  - "docker/**"
  - "README.md"
  - "Dockerfile"
  - "package.json"
---

# Config, docs, and packaging

## Config schema (`src/config/schema.ts`)
- zod 3. The schema is the single source of truth for every option and its default. `loadConfig(path?)` parses the JSON file named by `DITTO_MCP_CONFIG`; with no file, every default applies.
- Every section is `.default({})`, so zod 3 fills in each field's own default. (A comment in the file notes that zod 4 would need `.prefault({})` instead.) Follow the same pattern for new sections, and don't repeat defaults.
- Cross-field rules use `.refine` (e.g. `chunk.overlap < maxChars`). Checks that only matter at runtime, such as `baseUrl` when Ditto is enabled, live in the code that needs them, with a message naming the key.

## Adding or changing an option
1. Add the field with its default in `schema.ts`.
2. Cover defaults and validation in `config/load.test.ts`.
3. Update the README config table for the section (field, type, default, description), and the prose too if behavior changes. The README is the user documentation, and it states security-sensitive behavior precisely; keep it that way.
4. If the option belongs in a reference config, add it to `examples/*.json`, with placeholders for secrets and paths. Examples are parse-tested automatically.
5. If the image's default changes, update `docker/config.docker.json`. It must keep `host: "0.0.0.0"` and bearer auth with a `tokenFile`.
6. If the option affects the built index (retriever, embedding model or dim, chunking, sources): update the README section "When to run ingest", and decide whether `metaMatches` in `knowledge/build.ts` must reject an index built without it.

## Docker (`Dockerfile`)
- The base image is `node:22-slim`, pinned by its multi-arch digest (`ARG NODE_IMAGE`), with no `--platform` pin. It must stay Debian-based, never alpine: onnxruntime-node has no musl build.
- Build steps: `ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm ci`, then `npm run build` (whose `prebuild` hook fetches the pinned Ditto spec, so the builder copies `scripts/` and `openapi/` first), then `npm prune --omit=dev`.
- The runtime stage copies only `node_modules`, `dist`, `package.json`, `openapi/ditto-api-2.yml` (from the builder), and `docker/config.docker.json` (to `/app/config.docker.json`). A new runtime file outside `dist/` needs its own `COPY` here, and must not be excluded in `.dockerignore`.
- The container runs as `ditto` (uid 10001), with a `/app/data` volume for the SQLite index.

## Dependencies and versions
- `package-lock.json` is committed, and installs use `npm ci`. Justify any new runtime dependency; load heavy or native ones lazily (see `code-style.md`).
- The engine is Node >= 22. To bump the version, change `package.json` only; the server reports it from there.
