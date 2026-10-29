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

import type { CredentialConfig } from "../config/schema.js";

export interface DittoCredential {
  authHeader(signal?: AbortSignal): Promise<string | undefined>;
}

class StaticCredential implements DittoCredential {
  constructor(private readonly header: string | undefined) {}
  async authHeader(): Promise<string | undefined> {
    return this.header;
  }
}

interface OidcOptions {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope?: string;
}

export class OidcClientCredential implements DittoCredential {
  private token?: string;
  private expiresAt = 0;
  private inflight?: Promise<string>;

  constructor(private readonly opts: OidcOptions, private readonly fetchFn: typeof fetch = fetch) {}

  async authHeader(signal?: AbortSignal): Promise<string | undefined> {
    const now = Date.now();
    if (this.token && now < this.expiresAt) return `Bearer ${this.token}`;
    // Every caller needing a token awaits the same fetch, so it must not carry any one
    // caller's signal: a single cancelled tool call would fail all the others. A caller whose
    // signal aborts just stops waiting; one that already gave up starts no fetch.
    signal?.throwIfAborted();
    if (!this.inflight) this.inflight = this.fetchToken().finally(() => { this.inflight = undefined; });
    const token = await untilAborted(this.inflight, signal);
    return `Bearer ${token}`;
  }

  private async fetchToken(): Promise<string> {
    const body = new URLSearchParams({ grant_type: "client_credentials" });
    if (this.opts.scope) body.set("scope", this.opts.scope);
    const basic = Buffer.from(`${this.opts.clientId}:${this.opts.clientSecret}`).toString("base64");
    const res = await this.fetchFn(this.opts.tokenUrl, {
      method: "POST",
      headers: { authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`oidc token endpoint ${this.opts.tokenUrl} -> ${res.status}`);
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new Error("oidc token response missing access_token");
    this.token = json.access_token;
    this.expiresAt = Date.now() + Math.max(0, (json.expires_in ?? 300) - 30) * 1000;
    return this.token;
  }
}

/** Settle with `promise`, or reject with the abort reason as soon as `signal` aborts. */
function untilAborted<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    // Handle `promise` before anything else, so its rejection is never left unhandled.
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Build a credential from a single credential-config object (standard or devops slot). */
export function createConfigCredential(c: CredentialConfig, fetchFn: typeof fetch = fetch): DittoCredential {
  if (c.kind === "oidc") {
    if (!c.tokenUrl || !c.clientId || !c.clientSecret) {
      process.stderr.write("[ditto-mcp] oidc credential missing tokenUrl/clientId/clientSecret; using no credential\n");
      return new StaticCredential(undefined);
    }
    return new OidcClientCredential(
      { tokenUrl: c.tokenUrl, clientId: c.clientId, clientSecret: c.clientSecret, scope: c.scope },
      fetchFn,
    );
  }
  if (c.username !== undefined) {
    return new StaticCredential(`Basic ${Buffer.from(`${c.username}:${c.password ?? ""}`).toString("base64")}`);
  }
  return new StaticCredential(undefined);
}
