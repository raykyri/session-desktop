// The open sync event streams, by the session (or device) they belong to, so
// a sign-out closes that session's streams at once and the periodic check
// closes those whose session ended (`auth/session.ts`). A device's streams
// are closed by the sync server itself when the device is revoked.

export class StreamRegistry {
  private readonly bySession = new Map<string, Set<AbortController>>();
  private open = 0;

  /** Track a stream of `session` (a session id: the cookie's hash); its
   * controller aborts it. Answers a function to call when it ends. */
  add(session: string | null, controller: AbortController): () => void {
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
}
