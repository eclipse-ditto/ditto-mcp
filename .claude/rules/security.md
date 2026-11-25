---
paths:
  - "src/server/**"
  - "src/ditto/**"
  - "src/config/**"
  - "src/bin/**"
  - "docker/**"
  - "Dockerfile"
---

# Security invariants

The server holds powerful credentials. `ditto.devopsCredential` reaches `/devops/*` and the connectivity API, whose responses contain connection URIs with embedded passwords. Treat every change in `server/`, `ditto/`, and `config/` as security-relevant. Tests cover the invariants below; extend them when you touch this code.

## Identity
- Ditto sees only the server's own identity: `ditto.credential` for ordinary operations, and `ditto.devopsCredential`, **exclusively**, for sudo operations. A sudo operation without a devops credential is refused at the MCP layer (`operationToTool`). It is never retried with the standard credential.
- An `oidc` credential missing `tokenUrl`, `clientId` or `clientSecret` stops startup (`createConfigCredential` throws). Never degrade it to "no credential": in the devops slot that registers the sudo tools and sends them unauthenticated.
- Caller headers never pick the credential, replace it, or reach Ditto. `RequestCtx.headers` is informational only. `HttpDittoClient` builds its headers from the spec-declared header params of the operation (tool arguments, e.g. Ditto's `ce-*`), then the `DittoCredential` and the declared content type, which always win.
- Header params: `isReservedHeader` (`openapi.ts`) keeps `authorization`, `proxy-authorization`, `cookie`, `host`, `content-type`, `content-length`, `transfer-encoding`, and `connection` out of the parsed params, and the client skips them again; a value with CR or LF is refused. Never accept a header name from a tool argument or a caller, only from the spec.
- The HTTP bearer token authenticates the caller to this server, nothing more. `bearerAuthMiddleware` strips `authorization` from both `req.headers` and `req.rawHeaders` (the SDK reads `rawHeaders` through Hono), so tool handlers never see it.
- This design is deliberate: credential pass-through was removed. Don't bring forwarding back without an explicit decision from the maintainers. Per-user OIDC is planned as a separate tier.

## HTTP endpoint
- Fail closed: `createHttpApp` throws when `auth.mode` is `"none"` and `host` is not in the `LOOPBACK` set. That check stays the first thing the function does.
- Compare the bearer token with `secretEquals`, which takes sha256 digests and uses `timingSafeEqual`: no early exit, no length leak. Never compare secrets with `===`.
- The auth middleware runs before `express.json()`, so an unauthenticated request costs little.
- DNS-rebinding protection (`allowedHosts`) is a Host-header check, not access control. Never present it as an alternative to auth.
- Docs and examples use `tokenFile`, not an inline `token`.
- Failure responses: 401 with `WWW-Authenticate: Bearer`. A 500 says only `"Internal error"`; the details go to stderr. Never echo the token.

## Ditto action tools
- The default policy is read-only: `allowMethods: ["GET"]` and empty allowlists.
- `isSudo` (`tool-policy.ts`) is deliberately broad. An operation counts as sudo if it has a devops security scheme, an operationId starting with `sudo`, a path containing `/sudo`, a path starting with `/devops`, or **any `/connections` path, whatever security the spec declares**. Sudo operations get through only via `sudoAllowlist`; `allowMethods` never enables them. Don't narrow this classification.
- Path parameters (`encodePathParam` in `client.ts`): every segment is checked for `""`, `"."`, and `".."` and encoded with `encodeURIComponent` (keeping `:` for Ditto ids). Without that guard, `..` or an empty segment retargets the request to an operation the policy never exposed, such as deleting a whole thing. Only params named `*Path` (`attributePath`, `propertyPath`, `resourcePath`) are split on `/` (Ditto's policies route doesn't decode `%2F`), and each piece is checked; one trailing `/` is allowed for the root resource `thing:/`. Every other param stays one segment with `/` encoded. `bundled-spec.test.ts` asserts that exactly those three are split and that each is the last segment of its route; never widen the split to an id or a mid-route param.
- `baseUrl` is joined by string concatenation after stripping its trailing `/`. Don't use `new URL(path, base)`: it drops a reverse-proxy prefix.
- Action tool names carry the `ditto_` prefix, so no spec operation can shadow `search`, `get_chunk`, or `ping`.
- Never log credentials or tokens. OIDC errors name the token URL and the status code, nothing else.

## Knowledge inputs
- `PublicSource` follows only `http:`/`https:` links ending in `.md` or `.markdown` (against SSRF and corpus pollution), caps each response at 5 MB, and times out after 15 s.
- The pgvector table prefix is interpolated into SQL, so it is validated (`^[A-Za-z_][A-Za-z0-9_]*$`, at most 40 chars). Every value goes in as a `$n` parameter. Identifiers read from the catalog go through `escapeIdentifier` or `quote_ident`.

## Secrets and the image
- Never commit `config*.local.json`, `*.db`, models, corpus directories, or tokens. Examples use `REPLACE_ME` and `/path/to/...` placeholders.
- `docker/config.docker.json` must keep bearer auth with a `tokenFile` (asserted in `config/examples.test.ts`).
- The image runs as non-root (`ditto`, uid 10001).
