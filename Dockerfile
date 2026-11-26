# Copyright (c) 2026 Contributors to the Eclipse Foundation
#
# See the NOTICE file(s) distributed with this work for additional
# information regarding copyright ownership.
#
# This program and the accompanying materials are made available under the
# terms of the Eclipse Public License 2.0 which is available at
# http://www.eclipse.org/legal/epl-2.0
#
# SPDX-License-Identifier: EPL-2.0

# Base image pinned by its multi-arch index digest, so the same commit always
# builds on the same Node, npm and Debian libs. Each platform (amd64, arm64)
# resolves its own image from this one index; there is no --platform pin, so
# `docker build` targets the building machine's CPU.
# Currently node 22.23.4, npm 10.9.9, Debian bookworm. To update, take the
# top-level Digest from `docker buildx imagetools inspect node:22-slim`.
ARG NODE_IMAGE=node:22-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d

# ---- builder: compile native deps + tsc, then drop devDeps ----
# node:22-slim = Debian (glibc). Do NOT use alpine: onnxruntime-node
# (pulled by @huggingface/transformers) ships no musl prebuild.
FROM ${NODE_IMAGE} AS builder
WORKDIR /app

# Toolchain for better-sqlite3's fallback: it downloads a prebuilt binary
# for its exact version and compiles from source only if that download
# fails. Builder is throwaway — not shipped.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install deps first (better layer caching). 'npm ci' installs exactly what
# package-lock.json pins and fails if it disagrees with package.json, so every
# build gets the dependency tree the tests ran against.
# On linux/x64, onnxruntime-node's install script would also download ~340 MB
# of CUDA/TensorRT providers from GitHub, outside the lockfile. Inference here
# is CPU-only, so skip it (no-op on arm64).
COPY package.json package-lock.json ./
RUN ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm ci

# Build TypeScript -> dist/. 'npm run build' first runs fetch-spec, which puts
# the Ditto OpenAPI spec pinned in openapi/ditto-spec.json (git ref + sha256)
# at openapi/ditto-api-2.yml, downloading it unless the build context already
# holds a copy with the pinned hash.
COPY tsconfig.json ./
COPY scripts ./scripts
COPY openapi ./openapi
COPY src ./src
RUN npm run build

# Strip devDeps but keep the compiled native .node binaries.
RUN npm prune --omit=dev

# ---- runtime: slim image, prod deps + dist only, non-root ----
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Same base/arch as builder -> copying node_modules keeps native bindings valid.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json

# Bundled Ditto OpenAPI spec (fetched by the builder): the offline fallback for
# action tools when ditto.openApi sets none of path/url/version. Resolved as
# <pkg root>/openapi/.
COPY --from=builder /app/openapi/ditto-api-2.yml ./openapi/ditto-api-2.yml

# Baked default config (http, 0.0.0.0). Override by bind-mounting a file
# and pointing DITTO_MCP_CONFIG at it.
COPY docker/config.docker.json ./config.docker.json
ENV DITTO_MCP_CONFIG=/app/config.docker.json

# Writable dir for the sqlite knowledge index (see config.docker.json).
# Mount a volume here to persist across restarts.
RUN mkdir -p /app/data

# Run unprivileged.
RUN useradd --system --uid 10001 --home-dir /app ditto \
    && chown -R ditto:ditto /app
USER ditto
VOLUME ["/app/data"]

EXPOSE 3000
CMD ["node", "dist/bin/http.js"]
