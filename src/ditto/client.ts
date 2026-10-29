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

import { mediaType, type DittoOperation } from "./openapi.js";
import type { DittoCredential } from "./credential.js";

export interface DittoResponse {
  status: number;
  body: string;
}

export interface DittoClient {
  execute(
    op: DittoOperation,
    args: Record<string, unknown>,
    credential: DittoCredential,
    signal?: AbortSignal,
  ): Promise<DittoResponse>;
}

export class HttpDittoClient implements DittoClient {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    // Operation paths start with "/". Strip rather than use new URL(path, base), which would
    // drop a reverse-proxy prefix such as "https://gw/ditto".
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async execute(
    op: DittoOperation,
    args: Record<string, unknown>,
    credential: DittoCredential,
    signal?: AbortSignal,
  ): Promise<DittoResponse> {
    let path = op.path;
    const query = new URLSearchParams();
    for (const p of op.params) {
      const v = args[p.name];
      if (p.in === "path") {
        const value = String(v ?? "");
        // A segment must not retarget the request to an operation the ToolPolicy never exposed.
        // encodeURIComponent leaves dots alone and URL parsing resolves "." and "..":
        // DELETE .../features/{featureId} with ".." would reach DELETE .../things/{thingId}.
        // An empty segment names the parent collection: PUT .../attributes/{attributePath}
        // with "" would replace every attribute.
        // If multi-segment params are ever split on "/" instead of encoded whole, apply this
        // check to every piece, or "a/../b" brings the problem back.
        if (value === "" || value === "." || value === "..") {
          throw new Error(`path parameter ${p.name} must not be ${value === "" ? "empty" : `"${value}"`}`);
        }
        path = path.replace(`{${p.name}}`, encodeURIComponent(value).replace(/%3A/g, ":"));
      } else if (v !== undefined) {
        query.set(p.name, String(v));
      }
    }
    const qs = query.toString();
    const url = `${this.baseUrl}${path}${qs ? `?${qs}` : ""}`;

    const headers: Record<string, string> = {};
    const auth = await credential.authHeader(signal);
    if (auth) headers["authorization"] = auth;
    let body: string | undefined;
    if (op.hasBody && args.body !== undefined) {
      const contentType = op.contentType ?? "application/json";
      headers["content-type"] = contentType;
      body = encodeBody(args.body, contentType);
    }

    const res = await this.fetchFn(url, { method: op.method, headers, body, signal });
    return { status: res.status, body: await res.text() };
  }
}

function encodeBody(value: unknown, contentType: string): string {
  const type = mediaType(contentType);
  if (type === "application/json" || type.endsWith("+json")) return JSON.stringify(value);
  if (typeof value === "string") return value;
  if (type === "application/x-www-form-urlencoded" && value !== null && typeof value === "object") {
    return new URLSearchParams(Object.entries(value).map(([k, v]) => [k, String(v)])).toString();
  }
  return JSON.stringify(value);
}
