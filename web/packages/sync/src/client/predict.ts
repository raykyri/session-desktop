// Prediction over the replica (`01` Y11): the reads a mutator makes on a
// client, answered from the merged view with the pending writes' predicted
// records on top, and `UnknownRead` where the replica cannot know the
// answer, which stops the prediction (the write is sent unpredicted).
//
// What the replica can answer:
// - a key it holds; an absent key whose space or user log it replicates
//   (absent there means absent); an absent id-keyed record (a new id: the
//   server decides a collision);
// - an index by space when it replicates the space's log in full (save,
//   notification and preference indexes need the actor's user log);
// - an index by thread when it holds the thread in full (a summary thread
//   has no nodes, answers, replies, comments or runs here), or does not hold
//   the thread at all (a thread the write itself creates);
// - an index by person for the actor's own user log;
// - a unique lookup only when the record is held.
// The server-only reads (`Tx.server`) are never made on a client.

import {
  UnknownRead,
  inIndex,
  uniqueOf,
  type Index,
  type Kind,
  type LogId,
  type Source,
  type StoredRecord,
  type UniqueIndex,
} from "@session/mutators";

import { CONTENT_KINDS, type Replica } from "./replica.js";

/** Kinds that live in user logs only. */
const USER_KINDS: ReadonlySet<Kind> = new Set<Kind>(["save", "notif", "prefs"]);

/** The space or person a key names in itself, if its form says. */
function scopeOfKey(key: string): { space?: string; user?: string } {
  const [kind, a, b] = key.split(":");
  switch (kind) {
    case "space":
    case "stats":
      return a ? { space: a } : {};
    case "member":
    case "request":
    case "ban":
      return a ? { space: a, ...(b ? { user: b } : {}) } : {};
    case "save":
    case "prefs":
      return a ? { user: a } : {};
    default:
      return {};
  }
}

/** A `Source` over the replica's merged view and an overlay of predicted
 * records (null: deleted), for one person. */
export class OverlaySource implements Source {
  constructor(
    private readonly replica: Replica,
    private readonly overlay: ReadonlyMap<string, StoredRecord | null>,
    private readonly me: string,
  ) {}

  private has(log: LogId): boolean {
    return this.replica.state(log) !== undefined;
  }

  /** Whether the replica holds space `sp`'s log with every thread full. */
  private fullSpace(sp: string): boolean {
    const s = this.replica.state(`space:${sp}`);
    return s !== undefined;
  }

  byKey(key: string): StoredRecord | undefined {
    if (this.overlay.has(key)) return this.overlay.get(key) ?? undefined;
    const r = this.replica.get(key);
    if (r) return r;
    const scope = scopeOfKey(key);
    if (scope.space !== undefined && !this.has(`space:${scope.space}`)) {
      // a person's own membership is in their user log too
      if (!(key.startsWith("member:") && scope.user === this.me && this.has(`user:${this.me}`)))
        throw new UnknownRead(key);
    }
    if (scope.user !== undefined && !scope.space && !this.has(`user:${scope.user}`))
      throw new UnknownRead(key);
    return undefined;
  }

  keysIn(kind: Kind, index: Index): Iterable<string> {
    if ("u" in index) {
      if (index.u !== this.me || !this.has(`user:${this.me}`))
        throw new UnknownRead(`${kind} ${JSON.stringify(index)}`);
    } else if ("sp" in index) {
      const ok = USER_KINDS.has(kind) ? this.has(`user:${this.me}`) : this.fullSpace(index.sp);
      if (!ok) throw new UnknownRead(`${kind} ${JSON.stringify(index)}`);
    } else {
      const log = this.replica.logOfThread(index.th);
      if (log && CONTENT_KINDS.has(kind) && !this.replica.isFull(log, index.th))
        throw new UnknownRead(`${kind} ${JSON.stringify(index)}`);
      if (USER_KINDS.has(kind) && !this.has(`user:${this.me}`))
        throw new UnknownRead(`${kind} ${JSON.stringify(index)}`);
    }
    const keys = new Set(this.replica.keysIn(kind, index));
    for (const [k, r] of this.overlay) {
      if (r === null) keys.delete(k);
      else if (r.kind === kind && inIndex(r, index)) keys.add(k);
    }
    return keys;
  }

  uniqueKey(index: UniqueIndex, value: string): string | undefined {
    for (const [k, r] of this.overlay) if (r && uniqueOf(r, index) === value) return k;
    for (const k of this.replica.keysOfKind(index === "space.name" ? "space" : "invite")) {
      const r = this.byKey(k);
      if (r && uniqueOf(r, index) === value) return k;
    }
    throw new UnknownRead(`${index} ${value}`);
  }

  idTaken(): boolean {
    return false;
  }
}
