// The open sync event streams, by the session (or device) they belong to, so
// a sign-out closes that session's streams at once and the periodic check
// closes those whose session ended (`auth/session.ts`). A device's streams
// are closed by the sync server itself when the device is revoked.
//
// Each stream also counts against its reader (review round 2 of phase 2,
// finding 9): a browser session, a device, or, signed out, the client's
// address (`addressKey`: an IPv6 address by its /64). A reader holds at most
// `perReader` open streams (`SESSION_STREAMS_PER_READER`, default 8: the web
// client opens one a tab, the desktop one); past it a new stream is refused
// (`GET /api/sync/events` answers TOO_MANY_REQUESTS, 429) until one closes.

export class StreamRegistry {
  private readonly bySession = new Map<string, Set<AbortController>>();
  private readonly byReader = new Map<string, number>();
  private open = 0;

  constructor(readonly perReader = 8) {}

  /** Track a stream of `session` (a session id: the cookie's hash); its
   * controller aborts it. `reader` is what the stream counts against
   * (`session:<id>`, `device:<id>`, `ip:<address key>`), or null for
   * nothing. Answers a function to call when it ends, or null when
   * `reader` holds `perReader` streams already (nothing is tracked). */
  add(
    session: string | null,
    controller: AbortController,
    reader: string | null = null,
  ): (() => void) | null {
    if (reader !== null) {
      const n = this.byReader.get(reader) ?? 0;
      if (n >= this.perReader) return null;
      this.byReader.set(reader, n + 1);
    }
    this.open++;
    if (session !== null) {
      const s = this.bySession.get(session) ?? new Set();
      s.add(controller);
      this.bySession.set(session, s);
    }
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.open--;
      if (reader !== null) {
        const n = (this.byReader.get(reader) ?? 1) - 1;
        if (n > 0) this.byReader.set(reader, n);
        else this.byReader.delete(reader);
      }
      if (session === null) return;
      const s = this.bySession.get(session);
      s?.delete(controller);
      if (s && s.size === 0) this.bySession.delete(session);
    };
  }

  /** Close every stream of `session`; answers how many. */
  closeSession(session: string): number {
    const s = this.bySession.get(session);
    if (!s) return 0;
    const n = s.size;
    for (const c of [...s]) c.abort();
    this.bySession.delete(session);
    return n;
  }

  sessionIds(): string[] {
    return [...this.bySession.keys()];
  }

  closeAll(): void {
    for (const id of this.sessionIds()) this.closeSession(id);
  }

  /** Open streams, for `/metrics`. */
  get size(): number {
    return this.open;
  }

  /** The open streams of `reader` (tests). */
  of(reader: string): number {
    return this.byReader.get(reader) ?? 0;
  }
}
