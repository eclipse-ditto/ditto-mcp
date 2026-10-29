---
paths:
  - "src/ditto/**"
  - "openapi/**"
  - "scripts/fetch-ditto-spec.mjs"
---

# Ditto action tools

Security constraints for this code live in `security.md`. This file covers how it works.

## Pipeline (runs once, at startup)
`registerTools` lazily imports `ditto/action-tools.js` and calls `makeActionTools(config, deps?)`, which:
1. Builds the client. `ditto.baseUrl` is required; without it, it throws and startup fails.
2. Loads the spec, first match wins: `openApi.path`, then `openApi.url`, then `openApi.version` (filled into `versionUrlTemplate`), then the bundled `openapi/ditto-api-2.yml` (`BUNDLED_SPEC_PATH`, fetched by `npm run fetch-spec`). The YAML parser also reads JSON. A failure throws `cannot build the Ditto action tools: ...`.
3. Creates the credentials with `createConfigCredential`: `credential` (standard) and `devopsCredential` (optional).
4. `parseOperations(spec)` turns the spec into `DittoOperation[]` (`openapi.ts`).
5. Keeps only operations where `isAllowed(op, policy)` holds (`tool-policy.ts`).
6. Turns each into a tool with `operationToTool(op, client, creds)` (`action-tool.ts`).
7. De-duplicates names: a collision gets the first free `_2`, `_3`, … suffix that fits in 64 chars and isn't held by any other action tool.

## Parsing (`openapi.ts`)
- Methods: get, put, post, delete, patch. Parameters: only `path` and `query`. Path-item parameters are merged in, with the operation's own winning on a name clash. Path parameters are always required.
- One level of `$ref` is resolved, for `components/parameters`, `components/requestBodies`, and `components/schemas`.
- Ditto's spec declares **no operationIds**. Each operation gets a synthesized id, `"<METHOD>_<path>"`, which `toolName` recognizes.
- Body media type (`bodyMediaOf`): `application/json` if the operation declares it, otherwise the first concrete type; if only a wildcard is declared, send JSON. Compare types with `mediaType()` (drops parameters, lowercases). Ditto rejects a type the route doesn't declare: its PATCH routes accept only `application/merge-patch+json`.
- In a merge-patch body (`MERGE_PATCH`) no field is required, and every field is nullable (null deletes the field).
- Body schemas cover top-level properties only. Nested values are freeform (`z.record(z.any())`, `z.array(z.any())`, `z.any()`), and the body object is `.passthrough()`.
- An operation's security schemes are `op.security ?? spec.security`, flattened to scheme names. `isSudo` reads them.

## Naming (`toolName` in `action-tool.ts`)
The name is `ditto_` plus a sanitized id: only `[A-Za-z0-9_]`, with runs of `_` collapsed. For a synthesized id, that is `METHOD_` plus the path without its `/api/2` prefix, keeping only a trailing `{param}`; for example, `ditto_GET_things_thingId`. A name over 64 chars is cut and gets `_` plus 8 hex chars of sha256(`"METHOD path"`). Clients see these names, and the README lists examples, so changing the scheme is a breaking change: update the README with it.

## Policy keys
An allowlist entry is either an operationId or `"METHOD /raw/spec/{path}"`, with the braces kept. Since Ditto's spec has no operationIds, use the `METHOD path` form.

## Client (`client.ts`)
- The URL is the stripped `baseUrl`, plus the path with its parameters substituted, plus a query string of the params that have values.
- A body is sent only when `op.hasBody` and `args.body !== undefined`. `encodeBody` encodes it by media type: JSON and `+json` types with `JSON.stringify`, a form-urlencoded object with `URLSearchParams`, a string as-is.
- `execute` returns `{ status, body }`, and the tool answers with the text `HTTP <status>\n<body>`. A non-2xx status is a result, not an exception.

## Credentials (`credential.ts`)
- `basic` sends a static `Authorization: Basic ...` header. Without a username, no header is sent.
- `oidc` uses `OidcClientCredential`: a client_credentials grant with HTTP Basic client authentication. The token is cached until `expires_in` minus 30 s; concurrent callers share one in-flight fetch, which times out after 15 s. If tokenUrl, clientId, or clientSecret is missing, it logs a warning and sends no credential.

## Bundled spec
`openapi/ditto-api-2.yml` is Ditto's spec, verbatim, and is not checked in. `openapi/ditto-spec.json` pins the Ditto git ref and the file's sha256; `scripts/fetch-ditto-spec.mjs` (`npm run fetch-spec`) downloads it and refuses any other hash. The `pretest`, `prebuild`, `predev:stdio` and `predev:http` hooks run it, and so does the Docker builder through `npm run build`. Never commit the yml or edit it by hand. To move to another Ditto release, follow `openapi/README.md`, then re-run `ditto/bundled-spec.test.ts` and check the README tool-name examples still match.
