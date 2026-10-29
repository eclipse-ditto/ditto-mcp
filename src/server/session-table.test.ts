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
import { SessionTable } from "./session-table.js";

/** A transport stand-in that records being closed and, like the real one, then leaves the table. */
function fakeTransport(table: () => SessionTable<{ close(): Promise<void> }>, id: string) {
  const t = {
    closed: false,
    async close() {
      t.closed = true;
      table().remove(id);
    },
  };
  return t;
}

function setup(maxSessions: number, idleTimeoutMs = 1000) {
  let now = 0;
  const table: SessionTable<{ close(): Promise<void> }> = new SessionTable(maxSessions, idleTimeoutMs, () => now);
  const open = (id: string) => {
    const reservation = table.reserve();
    if (!reservation) throw new Error(`no room for ${id}`);
    const transport = fakeTransport(() => table, id);
    return { session: table.add(id, transport, reservation)!, transport };
  };
  return { table, open, advance: (ms: number) => { now += ms; } };
}

describe("SessionTable", () => {
  it("counts an outstanding reservation against the cap", () => {
    // Concurrent initializes each reserve before any is added; they must not share the last slot.
    const { table } = setup(1);
    expect(table.reserve()).toBeDefined();
    expect(table.reserve()).toBeUndefined();
  });

  it("frees the slot of a reservation that is released", () => {
    const { table } = setup(1);
    table.release(table.reserve()!);
    expect(table.reserve()).toBeDefined();
  });

  it("at the cap, replaces the least recently active idle session, but only once the new one is added", () => {
    const { table, open, advance } = setup(2);
    const a = open("a");
    advance(1);
    const b = open("b");
    advance(1);
    table.begin(a.session);
    table.end(a.session); // a is now more recent than b
    const reservation = table.reserve()!;
    expect(b.transport.closed).toBe(false);
    table.add("c", fakeTransport(() => table, "c"), reservation);
    expect(b.transport.closed).toBe(true);
    expect(table.get("b")).toBeUndefined();
    expect(table.get("a")).toBeDefined();
  });

  it("refuses to add a session whose reservation was already released", () => {
    // The client dropped the initialize's connection, but the SDK still started its session.
    const { table, open } = setup(1);
    const a = open("a");
    const reservation = table.reserve()!; // would replace a
    table.release(reservation);
    expect(table.add("late", fakeTransport(() => table, "late"), reservation)).toBeUndefined();
    expect(table.get("late")).toBeUndefined();
    expect(a.transport.closed).toBe(false);
  });

  it("spares the session a released reservation would have replaced", () => {
    const { table, open } = setup(1);
    const a = open("a");
    table.release(table.reserve()!);
    expect(a.transport.closed).toBe(false);
    expect(table.get("a")).toBeDefined();
  });

  it("keeps counting a reservation whose session to replace was swept meanwhile", () => {
    const { table, open, advance } = setup(1, 1000);
    open("a");
    expect(table.reserve()).toBeDefined(); // will replace a
    advance(1001);
    table.sweep(); // a goes away on its own; the reservation still holds the only slot
    expect(table.reserve()).toBeUndefined();
  });

  it("gives concurrent reservations different sessions to replace", () => {
    const { table, open, advance } = setup(2);
    const a = open("a");
    advance(1);
    const b = open("b");
    const r1 = table.reserve()!;
    const r2 = table.reserve()!;
    expect(table.reserve()).toBeUndefined();
    table.add("c", fakeTransport(() => table, "c"), r1);
    table.add("d", fakeTransport(() => table, "d"), r2);
    expect([a.transport.closed, b.transport.closed]).toEqual([true, true]);
  });

  it("replaces a busy session only once it has been inactive longer than the idle timeout", () => {
    // A stream to a vanished client may never close, but an active client must not be pushed out.
    const { table, open, advance } = setup(1, 1000);
    const a = open("a");
    table.begin(a.session); // e.g. a long-lived GET event stream
    advance(500);
    expect(table.reserve()).toBeUndefined();
    advance(600);
    expect(table.reserve()).toBeDefined();
  });

  it("sweeps idle sessions past the timeout and keeps busy ones", () => {
    const { table, open, advance } = setup(10, 1000);
    const idle = open("idle");
    const busy = open("busy");
    table.begin(busy.session);
    advance(1001);
    table.sweep();
    expect(idle.transport.closed).toBe(true);
    expect(busy.transport.closed).toBe(false);
  });
});
