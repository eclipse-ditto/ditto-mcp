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

import { describe, it, expect, vi } from "vitest";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { PublicSource } from "./public-source.js";
import type { Chunk } from "./types.js";

const INDEX = `# Ditto docs
## Core
- [Things](https://eclipse.dev/ditto/things.md): about things
- [Policies](https://eclipse.dev/ditto/policies.md): about policies
Some prose that is not a link.
`;

const DOCS: Record<string, string> = {
  "https://eclipse.dev/ditto/llms.txt": INDEX,
  "https://eclipse.dev/ditto/things.md": "# Things\n\nA thing is a digital twin.",
  "https://eclipse.dev/ditto/policies.md": "# Policies\n\nPolicies control access.",
};

const fakeFetch = async (url: string): Promise<string> => {
  if (!(url in DOCS)) throw new Error(`404 ${url}`);
  return DOCS[url];
};

describe("PublicSource", () => {
  it("parses the index and chunks each linked document", async () => {
    const src = new PublicSource({
      url: "https://eclipse.dev/ditto/llms.txt",
      fetchFn: fakeFetch,
    });
    const chunks = await src.loadChunks();
    expect(src.id).toBe("public");
    const cites = new Set(chunks.map((c) => c.cite));
    expect(cites.has("https://eclipse.dev/ditto/things.md")).toBe(true);
    expect(cites.has("https://eclipse.dev/ditto/policies.md")).toBe(true);
    expect(chunks.some((c) => c.text.includes("digital twin"))).toBe(true);
    expect(chunks.every((c) => c.source === "public")).toBe(true);
  });

  it("honors maxDocs", async () => {
    const src = new PublicSource({
      url: "https://eclipse.dev/ditto/llms.txt",
      fetchFn: fakeFetch,
      maxDocs: 1,
    });
    const chunks = await src.loadChunks();
    expect(new Set(chunks.map((c) => c.cite)).size).toBe(1);
  });

  it("ingests only markdown links, skipping HTML/non-.md entries", async () => {
    const index = `# Ditto docs
- [Repo](https://github.com/eclipse-ditto/ditto): source
- [OpenAPI](https://eclipse.dev/ditto/openapi/): api ui
- [Things](https://eclipse.dev/ditto/things.md): about things`;
    const src = new PublicSource({
      url: "https://eclipse.dev/ditto/llms.txt",
      fetchFn: async (u) => {
        if (u === "https://eclipse.dev/ditto/llms.txt") return index;
        if (u === "https://eclipse.dev/ditto/things.md")
          return "# Things\n\nA thing is a digital twin.";
        throw new Error(`should not fetch non-markdown url: ${u}`);
      },
    });
    const chunks = await src.loadChunks();
    const cites = new Set(chunks.map((c) => c.cite));
    expect(cites).toEqual(new Set(["https://eclipse.dev/ditto/things.md"]));
  });

  it("reports documents that fail to fetch and loads the rest", async () => {
    const skipped: Array<[string, string]> = [];
    const src = new PublicSource({
      url: "https://eclipse.dev/ditto/llms.txt",
      fetchFn: async (u) => {
        if (u.endsWith("policies.md")) throw new Error("boom");
        return fakeFetch(u);
      },
    });
    const chunks = await src.loadChunks(undefined, (item, reason) => {
      skipped.push([item, reason]);
    });
    expect(skipped).toEqual([["https://eclipse.dev/ditto/policies.md", "boom"]]);
    expect(chunks.some((c) => c.cite.endsWith("things.md"))).toBe(true);
    expect(chunks.some((c) => c.cite.endsWith("policies.md"))).toBe(false);
  });

  it("warns about a malformed link in the index, skips it without failing, and loads the rest", async () => {
    // A broken upstream link does not heal on re-run, so it must not fail a strict ingest.
    const skipped: Array<[string, string]> = [];
    const warnings: string[] = [];
    const write = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      warnings.push(String(chunk));
      return true;
    });
    const index = `# Ditto docs
- [Broken](http://[bad/broken.md): unparseable host
- [Things](https://eclipse.dev/ditto/things.md): about things`;
    const src = new PublicSource({
      url: "https://eclipse.dev/ditto/llms.txt",
      fetchFn: async (u) => (u.endsWith("llms.txt") ? index : fakeFetch(u)),
    });
    const chunks = await src.loadChunks(undefined, (item, reason) => {
      skipped.push([item, reason]);
    });
    write.mockRestore();
    expect(skipped).toEqual([]);
    expect(warnings.join("")).toContain("http://[bad/broken.md");
    expect(new Set(chunks.map((c) => c.cite))).toEqual(new Set(["https://eclipse.dev/ditto/things.md"]));
  });

  it("reports the network error behind a failed document fetch", async () => {
    const skipped: Array<[string, string]> = [];
    const src = new PublicSource({
      url: "https://eclipse.dev/ditto/llms.txt",
      fetchFn: async (u) => {
        if (u.endsWith("policies.md")) throw new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } });
        return fakeFetch(u);
      },
    });
    await src.loadChunks(undefined, (item, reason) => {
      skipped.push([item, reason]);
    });
    expect(skipped).toEqual([["https://eclipse.dev/ditto/policies.md", "fetch failed: ENOTFOUND"]]);
  });

  it("names the llms.txt URL and the network error when the index cannot be fetched", async () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), { code: "ECONNREFUSED" });
    const src = new PublicSource({
      url: "https://eclipse.dev/ditto/llms.txt",
      fetchFn: async () => {
        throw new TypeError("fetch failed", { cause });
      },
    });
    await expect(src.loadChunks()).rejects.toThrow(
      "cannot fetch https://eclipse.dev/ditto/llms.txt: fetch failed: ECONNREFUSED",
    );
  });

  it("throws when the index has no markdown links", async () => {
    const src = new PublicSource({
      url: "https://eclipse.dev/ditto/llms.txt",
      fetchFn: async () => "<html><body>Please verify you are human</body></html>",
    });
    await expect(src.loadChunks()).rejects.toThrow(/no markdown links/);
  });

  it("fetches a document listed twice only once", async () => {
    let fetchCount = 0;
    const indexWithDuplicate = `# Ditto docs
- [Things](https://eclipse.dev/ditto/things.md): about things
- [Things Again](https://eclipse.dev/ditto/things.md): same url
`;
    const src = new PublicSource({
      url: "https://eclipse.dev/ditto/llms.txt",
      fetchFn: async (u) => {
        if (u === "https://eclipse.dev/ditto/llms.txt") return indexWithDuplicate;
        if (u === "https://eclipse.dev/ditto/things.md") {
          fetchCount++;
          return "# Things\n\nA thing is a digital twin.";
        }
        throw new Error(`404 ${u}`);
      },
    });
    const chunks = await src.loadChunks();
    expect(fetchCount).toBe(1);
    expect(new Set(chunks.map((c) => c.id)).size).toBe(chunks.length);
  });

  it("ids of an unchanged document survive an edit to another document", async () => {
    const load = (docs: Record<string, string>) => new PublicSource({
      url: "https://eclipse.dev/ditto/llms.txt", chunkOptions: { maxChars: 40, overlap: 0 },
      fetchFn: async (u) => { if (!(u in docs)) throw new Error(`404 ${u}`); return docs[u]; },
    }).loadChunks();
    const before = await load(DOCS);
    const edited = { ...DOCS, "https://eclipse.dev/ditto/things.md":
      "# Things\n\nA brand new opening paragraph.\n\n" + DOCS["https://eclipse.dev/ditto/things.md"] };
    const after = await load(edited);
    const ids = (cs: Chunk[]) => cs.filter((c) => c.cite.endsWith("policies.md")).map((c) => c.id);
    expect(ids(after)).toEqual(ids(before));
    expect(ids(before).length).toBeGreaterThan(0);
  });

  describe("default fetch: 5 MB response cap", () => {
    // Serves an llms.txt linking /doc.md, answered by `doc`. Uses the real fetch (no fetchFn),
    // on loopback only.
    async function serve(doc: (res: ServerResponse) => void) {
      const server = createServer((req, res) => {
        if (req.url === "/llms.txt") res.end("- [Doc](/doc.md)\n");
        else doc(res);
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const { port } = server.address() as AddressInfo;
      const stop = () => {
        server.closeAllConnections();
        return new Promise<void>((r) => server.close(() => r()));
      };
      return { url: `http://127.0.0.1:${port}/llms.txt`, stop };
    }

    async function skippedReasons(url: string): Promise<string[]> {
      const reasons: string[] = [];
      await expect(new PublicSource({ url }).loadChunks(undefined, (_item, reason) => reasons.push(reason)))
        .resolves.toEqual([]);
      return reasons;
    }

    it("refuses a body declared larger than the cap without reading it", async () => {
      const srv = await serve((res) => {
        res.writeHead(200, { "content-length": String(6_000_000) });
        res.write("# never finished");
      });
      try {
        expect(await skippedReasons(srv.url)).toEqual([expect.stringMatching(/response too large/)]);
      } finally { await srv.stop(); }
    });

    it("stops reading a body that grows past the cap", async () => {
      // An endless chunked body: buffering it whole would run into the 15 s timeout (or OOM)
      // before any length check.
      const srv = await serve((res) => {
        const piece = "x".repeat(64 * 1024);
        const pump = () => { while (res.write(piece)); };
        res.on("drain", pump);
        pump();
      });
      try {
        expect(await skippedReasons(srv.url)).toEqual([expect.stringMatching(/response too large/)]);
      } finally { await srv.stop(); }
    }, 10_000);

    it("counts bytes, not characters", async () => {
      // 3 M two-byte characters: under the cap as a string length, 6 MB on the wire.
      const srv = await serve((res) => res.end("é".repeat(3_000_000)));
      try {
        expect(await skippedReasons(srv.url)).toEqual([expect.stringMatching(/response too large/)]);
      } finally { await srv.stop(); }
    });

    it("reads a body under the cap", async () => {
      const srv = await serve((res) => res.end("# Doc\n\nCafé crème."));
      try {
        const chunks = await new PublicSource({ url: srv.url }).loadChunks();
        expect(chunks.map((c) => c.text).join("")).toContain("Café crème.");
      } finally { await srv.stop(); }
    });
  });
});
