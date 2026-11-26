# Bundled Ditto OpenAPI spec

`ditto-api-2.yml` is Eclipse Ditto's HTTP API spec, used as the offline fallback when
`ditto.openApi` sets none of `path`, `url` or `version`. It is not checked in:
`npm run fetch-spec` (`scripts/fetch-ditto-spec.mjs`) downloads it from
`eclipse-ditto/ditto` → `documentation/src/main/resources/openapi/ditto-api-2.yml` at the git
ref pinned in `ditto-spec.json`, and refuses a download whose sha256 differs from the pinned
one. `npm test`, `npm run build`, `npm run dev:stdio`, `npm run dev:http` and the Docker build
run it first. A file that already matches the pin is kept and nothing is fetched.

- Pinned to Ditto `3.9.8`. The file is byte-identical in every release from `3.9.0` to `3.9.8`.

Without access to raw.githubusercontent.com, copy the file from a Ditto checkout at the pinned
ref; the hash check accepts it:

```bash
git -C ../ditto show 3.9.8:documentation/src/main/resources/openapi/ditto-api-2.yml > openapi/ditto-api-2.yml
```

To move to another Ditto release, set `ref` in `ditto-spec.json` and run
`npm run fetch-spec`. It fails with the downloaded file's sha256; after checking that this is
the file you meant, put it in `sha256`, run `npm run fetch-spec` again, then `npm test`
(`src/ditto/bundled-spec.test.ts` pins facts about the spec) and check the tool-name examples in
the root README still match.

To target a specific Ditto release at runtime instead, set `ditto.openApi.version`.
