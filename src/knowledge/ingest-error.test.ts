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

import { describe, it, expect } from "vitest";
import { errorReason } from "./ingest-error.js";

describe("errorReason", () => {
  it("is the message when there is no cause", () => {
    expect(errorReason(new Error("boom"))).toBe("boom");
  });

  it("adds the cause's code, where Node's fetch puts the network error", () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9"), { code: "ECONNREFUSED" });
    expect(errorReason(new TypeError("fetch failed", { cause }))).toBe("fetch failed: ECONNREFUSED");
  });

  it("adds the cause's message when it has no code", () => {
    expect(errorReason(new TypeError("fetch failed", { cause: new Error("bad port") }))).toBe("fetch failed: bad port");
  });

  it("ignores a cause that carries neither", () => {
    expect(errorReason(new Error("boom", { cause: "x" }))).toBe("boom");
    expect(errorReason(new Error("boom", { cause: {} }))).toBe("boom");
  });

  it("stringifies a non-Error", () => {
    expect(errorReason("boom")).toBe("boom");
  });
});
