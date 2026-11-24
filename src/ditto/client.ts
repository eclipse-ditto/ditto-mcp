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
        path = path.replace(`{${p.name}}`, encodePathParam(p.name, String(v ?? "")));
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

// attributePath, propertyPath and resourcePath are paths inside an entity, and Ditto must see their
// slashes as slashes: its policies route does not decode %2F, so "thing:%2Ffeatures%2Flamp" names
// no resource, and a PUT of it creates a bogus entry that matches nothing. Every other param stays
// one encoded segment, so a "/" in a thingId cannot reach another operation.
const MULTI_SEGMENT_PARAM = /Path$/;

function encodePathParam(name: string, value: string): string {
  const multi = MULTI_SEGMENT_PARAM.test(name);
  // One trailing "/" is harmless and needed: "thing:/" is the root resource.
  const pieces = multi ? value.replace(/\/$/, "").split("/") : [value];
  for (const piece of pieces) {
    // A segment must not retarget the request to an operation the ToolPolicy never exposed.
    // encodeURIComponent leaves dots alone and URL parsing resolves "." and "..":
    // DELETE .../features/{featureId} with ".." would reach DELETE .../things/{thingId}.
    // An empty segment names the parent collection: PUT .../attributes/{attributePath}
    // with "" would replace every attribute.
    if (piece === "" || piece === "." || piece === "..") {
      const what = piece === "" ? "empty" : `"${piece}"`;
      throw new Error(`path parameter ${name} must not ${pieces.length > 1 ? "contain a segment that is" : "be"} ${what}`);
    }
  }
  const encode = (s: string) => encodeURIComponent(s).replace(/%3A/g, ":");
  return multi ? value.split("/").map(encode).join("/") : encode(value);
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
