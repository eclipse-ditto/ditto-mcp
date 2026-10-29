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

export interface Session<T> {
  readonly id: string;
  readonly transport: T;
  lastActive: number;
  /** Requests in flight, including a client's long-lived GET event stream. */
  openRequests: number;
}

/** Room held for one initialize, from admission until its session is added or the request ends. */
export interface Reservation<T> {
  /** The session to close once the new one is added; set when admitted at the cap. */
  victim?: Session<T>;
  settled: boolean;
}

/**
 * MCP sessions, bounded by a cap and an idle timeout. A closed session's client gets 404 on its
 * next request and re-initializes.
 *
 * Admission is split in two because the transport validates an initialize (Host/Origin checks)
 * only after we hand it the request: `reserve` decides synchronously whether there is room, so
 * concurrent initializes cannot share the last slot, and `add` evicts only once the transport
 * has accepted the request, so a rejected one evicts nobody.
 */
export class SessionTable<T extends { close(): Promise<void> }> {
  private readonly sessions = new Map<string, Session<T>>();
  private pending = 0;
  /** Sessions a pending reservation will close; not offered to another reservation. */
  private readonly doomed = new Set<Session<T>>();

  constructor(
    private readonly maxSessions: number,
    private readonly idleTimeoutMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get(id: string): Session<T> | undefined {
    return this.sessions.get(id);
  }

  /** Room for a new session, or undefined when the cap is reached and no session may be replaced. */
  reserve(): Reservation<T> | undefined {
    let victim: Session<T> | undefined;
    if (this.sessions.size - this.doomed.size + this.pending >= this.maxSessions) {
      victim = this.evictionCandidate();
      if (!victim) return undefined;
      this.doomed.add(victim);
    }
    this.pending++;
    return { victim, settled: false };
  }

  /**
   * Add the session for a reservation, or undefined when the reservation was already released:
   * the initialize's request ended (client gone) before the transport started the session. The
   * caller must then close the transport; the slot may already be someone else's.
   */
  add(id: string, transport: T, reservation: Reservation<T>): Session<T> | undefined {
    if (reservation.settled) return undefined;
    this.settle(reservation, true);
    const session: Session<T> = { id, transport, lastActive: this.now(), openRequests: 0 };
    this.sessions.set(id, session);
    return session;
  }

  /** The initialize ended without a session; a no-op once the session was added. */
  release(reservation: Reservation<T>): void {
    this.settle(reservation, false);
  }

  /** Forget a session whose transport closed. */
  remove(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    this.doomed.delete(session);
    this.sessions.delete(id);
  }

  begin(session: Session<T>): void {
    session.openRequests++;
    session.lastActive = this.now();
  }

  end(session: Session<T>): void {
    session.openRequests--;
    session.lastActive = this.now();
  }

  /** Close sessions with no request in flight for longer than the idle timeout. */
  sweep(): void {
    const cutoff = this.now() - this.idleTimeoutMs;
    for (const s of this.sessions.values()) {
      if (s.openRequests === 0 && s.lastActive < cutoff) this.close(s);
    }
  }

  private settle(reservation: Reservation<T>, commit: boolean): void {
    if (reservation.settled) return;
    reservation.settled = true;
    this.pending--;
    const victim = reservation.victim;
    if (!victim) return;
    this.doomed.delete(victim);
    if (commit) this.close(victim);
  }

  private close(session: Session<T>): void {
    if (this.sessions.get(session.id) !== session) return; // already gone
    this.sessions.delete(session.id);
    this.doomed.delete(session);
    void session.transport.close();
  }

  // The least recently active idle session, however recently it was used, else a busy one
  // inactive for longer than the idle timeout (a stream to a vanished client may never close).
  // A busy session that was recently active is never replaced.
  private evictionCandidate(): Session<T> | undefined {
    const cutoff = this.now() - this.idleTimeoutMs;
    const byAge = [...this.sessions.values()]
      .filter((s) => !this.doomed.has(s))
      .sort((a, b) => a.lastActive - b.lastActive);
    return byAge.find((s) => s.openRequests === 0) ?? byAge.find((s) => s.lastActive < cutoff);
  }
}
