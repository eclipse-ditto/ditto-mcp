/*
 * Copyright (c) 2026 Contributors to the Eclipse Foundation
 *
 * See the NOTICE file(s) distributed with this work for additional
 * information regarding copyright ownership.
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0
 *
 * SPDX-License-Identifier: EPL-2.0
 */

import { z } from "zod";

const CredentialSchema = z.object({
  kind: z.enum(["basic", "oidc"]).default("basic"),
  username: z.string().optional(),
  password: z.string().optional(),
  tokenUrl: z.string().optional(),
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
  scope: z.string().optional(),
});

export type CredentialConfig = z.infer<typeof CredentialSchema>;

/**
 * Authentication for the HTTP `/mcp` endpoint itself — distinct from `ditto.credential`,
 * which is the identity the server presents *to Ditto*. The caller sends the shared token as
 * `Authorization: Bearer <token>`; it only grants access to this server and never reaches Ditto.
 */
const HttpAuthSchema = z
  .object({
    mode: z.enum(["none", "bearer"]).default("none"),
    token: z.string().optional(),
    tokenFile: z.string().optional(),
  })
  .default({});

export type HttpAuthConfig = z.infer<typeof HttpAuthSchema>;

// Sections default to {}: zod 3 parses a default through the object schema, so each field's own
// default fills it in. zod 4's .default() skips that parse; there it would have to be .prefault({}).
export const AppConfigSchema = z
  .object({
    server: z
      .object({
        name: z.string().default("ditto-mcp"),
        http: z
          .object({
            port: z.number().int().positive().default(3000),
            host: z.string().default("127.0.0.1"),
            enableDnsRebindingProtection: z.boolean().default(true),
            allowedHosts: z.array(z.string()).optional(),
            allowedOrigins: z.array(z.string()).optional(),
            sessionIdleTimeoutMs: z.number().int().positive().default(30 * 60_000),
            maxSessions: z.number().int().positive().default(100),
            auth: HttpAuthSchema,
          })
          .default({}),
      })
      .default({}),
    tools: z
      .object({ ping: z.boolean().default(true) })
      .default({}),
    knowledge: z
      .object({
        enabled: z.boolean().default(true),
        retriever: z.enum(["fts", "vector", "hybrid"]).default("fts"),
        embedding: z
          .object({
            model: z.string().default("Xenova/bge-small-en-v1.5"),
            dim: z.number().int().positive().default(384),
            modelPath: z.string().optional(),
            allowRemoteModels: z.boolean().default(true),
            cacheDir: z.string().optional(),
            batchSize: z.number().int().positive().default(32),
          })
          .default({}),
        chunk: z
          .object({
            maxChars: z.number().int().positive().default(1000),
            overlap: z.number().int().min(0).default(150),
          })
          .refine((c) => c.overlap < c.maxChars, {
            message: "knowledge.chunk.overlap must be less than maxChars",
          })
          .default({}),
        search: z
          .object({
            limit: z.number().int().positive().max(20).default(5),
            context: z.number().int().min(0).max(5).default(1),
          })
          .default({}),
        localDir: z
          .object({
            enabled: z.boolean().default(false),
            paths: z.array(z.string()).optional(),
            id: z.string().default("local"),
          })
          .default({}),
        publicSource: z
          .object({
            enabled: z.boolean().default(true),
            url: z
              .string()
              .default("https://eclipse.dev/ditto/llms.txt"),
            maxDocs: z.number().int().positive().optional(),
          })
          .default({}),
        store: z
          .object({
            kind: z.enum(["sqlite", "pgvector"]).default("sqlite"),
            sqlite: z
              .object({ path: z.string().optional() })
              .default({}),
            pgvector: z
              .object({
                connectionString: z.string().optional(),
                table: z.string().default("ditto_kn"),
              })
              .default({}),
          })
          .default({}),
      })
      .default({}),
    ditto: z
      .object({
        enabled: z.boolean().default(false),
        baseUrl: z.string().optional(),
        openApi: z
          .object({
            path: z.string().optional(),
            url: z.string().optional(),
            version: z.string().optional(),
            versionUrlTemplate: z
              .string()
              .default(
                "https://raw.githubusercontent.com/eclipse-ditto/ditto/${version}/documentation/src/main/resources/openapi/ditto-api-2.yml",
              ),
          })
          .default({}),
        credential: CredentialSchema.default({}),
        devopsCredential: CredentialSchema.optional(),
        policy: z
          .object({
            allowMethods: z.array(z.string()).default(["GET"]),
            writeAllowlist: z.array(z.string()).default([]),
            sudoAllowlist: z.array(z.string()).default([]),
          })
          .default({}),
      })
      .default({}),
  })
  .default({});

export type AppConfig = z.infer<typeof AppConfigSchema>;
