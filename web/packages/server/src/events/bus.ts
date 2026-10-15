// Event fan-out (`03-api-and-events.md` §3).
//
// One process, so the bus is a map from user id to that user's open
// connections. There is no replay buffer: a client that misses events
// refetches (`05-run-lifecycle-and-streaming.md` §4), which is why a
// connection whose queue overflows is closed rather than trimmed silently —
// Closes overflowed connections to trigger a full client resynchronization rather than silently dropping missed events.
//
// A thread's events (`emitToTree`) go to its audience: the owner's and the
// members' connections, and, for a public thread, the connections of other
// signed-in readers that declared the thread open (`setInterest` with
// `treeIds`). The same declaration is presence: who has a thread open, kept
// in memory, dropped when the connection closes or its declaration is not
// renewed within `PRESENCE_TTL_MS`, and announced as
// `research.presence.changed`. Guests have no event connection.

import type { SessionEvent, ThreadViewer } from "@session/shared";

/** Run deltas go only to connections that asked for the node
 * (`events.setInterest`); everything else goes to every connection. */
const INTEREST_FILTERED_PREFIX = "research.turn.";

/** Disconnects clients whose pending event queue exceeds MAX_QUEUED_EVENTS to bound server memory. */
const MAX_QUEUED_EVENTS = 2048;

export interface Subscription {
  connectionId: string;
  /** Yields until `close()`, an overflow, or the end of its session. */
  events: AsyncIterableIterator<SessionEvent>;
  close(): void;
  /** True once `closeSession` ended the connection: the session it was
   * opened with was signed out, deleted or expired. */
  sessionEnded(): boolean;
}

export interface SubscribeOptions {
  /** The `sessions` row the connection was opened with
   * (`auth.hashSessionToken` of the cookie). `closeSession` ends the
   * connections of one session; null for a connection that has none. */
  sessionId?: string | null;
}

export function sessionEvent(type: string, payload: Record<string, unknown>): SessionEvent {
  return { type, payload, timestamp: Date.now() };
}

/** The node a run event is about, when it carries one. */
function eventNodeId(event: SessionEvent): string | null {
  const nodeId = event.payload["nodeId"];
  return typeof nodeId === "string" ? nodeId : null;
}

/** How long a declared open thread counts as viewed without a renewal. */
export const PRESENCE_TTL_MS = 90_000;

/** Most threads one connection may declare open. */
export const MAX_OPEN_TREES = 20;

/** Who may receive a thread's events (`sharing.audience`). */
export interface TreeAudience {
  ownerId: string;
  memberIds: readonly string[];
  /** Other signed-in readers that declared the thread open receive it too. */
  public: boolean;
}

/** What the bus reads from the database: a thread's audience and how to show
 * a person in presence. Absent, `emitToTree` delivers nothing. */
export interface TreeDirectory {
  audience(treeId: string): TreeAudience | null;
  viewer(userId: string): ThreadViewer | null;
}

interface Connection {
  id: string;
  userId: string;
  sessionId: string | null;
  /** Set when `closeSession` ended it. */
  sessionEnded: boolean;
  interest: Set<string>;
  /** Threads the connection has open, with when it last said so. */
  openTrees: Map<string, number>;
  queue: SessionEvent[];
  /** Set while the iterator is parked waiting for the next event. */
  wake: ((event: IteratorResult<SessionEvent>) => void) | null;
  closed: boolean;
}

export class EventBus {
  readonly #byUser = new Map<string, Map<string, Connection>>();
  #directory: TreeDirectory | null;
  /** The viewer ids last announced per thread, to announce only changes. */
  readonly #presence = new Map<string, string>();
  readonly #now: () => number;

  constructor(directory: TreeDirectory | null = null, options: { now?: () => number } = {}) {
    this.#directory = directory;
    this.#now = options.now ?? Date.now;
  }

  /** Sets what `emitToTree` reads; the server sets it once at boot. */
  setDirectory(directory: TreeDirectory): void {
    this.#directory = directory;
  }

  #register(connection: Connection): void {
    let connections = this.#byUser.get(connection.userId);
    if (!connections) {
      connections = new Map();
      this.#byUser.set(connection.userId, connections);
    }
    // Closes previous SSE connection if a new connection is registered with the same connection ID.
    const replaced = connections.get(connection.id);
    if (replaced) {
      replaced.closed = true;
      replaced.wake?.({ value: undefined, done: true });
      replaced.wake = null;
    }
    connections.set(connection.id, connection);
  }

  /** Removes `connection` only while it is still the one registered under its
   * id, so a replaced connection's close does not evict its successor. */
  #unregister(connection: Connection): void {
    const connections = this.#byUser.get(connection.userId);
    if (!connections || connections.get(connection.id) !== connection) {
      return;
    }
    connections.delete(connection.id);
    if (connections.size === 0) {
      this.#byUser.delete(connection.userId);
    }
    for (const treeId of connection.openTrees.keys()) {
      this.#announcePresence(treeId);
    }
  }

  subscribe(
    userId: string,
    connectionId: string,
    signal?: AbortSignal,
    options: SubscribeOptions = {},
  ): Subscription {
    const connection: Connection = {
      id: connectionId,
      userId,
      sessionId: options.sessionId ?? null,
      sessionEnded: false,
      interest: new Set(),
      openTrees: new Map(),
      queue: [],
      wake: null,
      closed: false,
    };
    this.#register(connection);

    const close = (): void => {
      if (connection.closed) {
        return;
      }
      connection.closed = true;
      this.#unregister(connection);
      connection.wake?.({ value: undefined, done: true });
      connection.wake = null;
    };

    signal?.addEventListener("abort", close, { once: true });

    const events: AsyncIterableIterator<SessionEvent> = {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: (): Promise<IteratorResult<SessionEvent>> => {
        const queued = connection.queue.shift();
        if (queued !== undefined) {
          return Promise.resolve({ value: queued, done: false });
        }
        if (connection.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise<IteratorResult<SessionEvent>>((resolve) => {
          connection.wake = resolve;
        });
      },
      return: (): Promise<IteratorResult<SessionEvent>> => {
        close();
        return Promise.resolve({ value: undefined, done: true });
      },
      throw: (error?: unknown): Promise<IteratorResult<SessionEvent>> => {
        close();
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      },
    };

    return { connectionId, events, close, sessionEnded: () => connection.sessionEnded };
  }

  /** The sessions that have a connection open, for the periodic check that
   * ends the streams of expired sessions. */
  openSessionIds(): Set<string> {
    const ids = new Set<string>();
    for (const connections of this.#byUser.values()) {
      for (const connection of connections.values()) {
        if (connection.sessionId !== null && !connection.closed) ids.add(connection.sessionId);
      }
    }
    return ids;
  }

  /**
   * Ends every connection opened with `sessionId`: called when that session
   * is signed out or deleted, and by the periodic check when it expired. The
   * stream's iterator finishes with `sessionEnded()` true, which
   * `events.subscribe` turns into `UNAUTHORIZED`. Returns how many
   * connections it ended.
   */
  closeSession(sessionId: string): number {
    let closed = 0;
    for (const connections of [...this.#byUser.values()]) {
      for (const connection of [...connections.values()]) {
        if (connection.sessionId !== sessionId || connection.closed) continue;
        connection.sessionEnded = true;
        // Events queued before the session ended are not delivered either.
        connection.queue = [];
        connection.closed = true;
        this.#unregister(connection);
        connection.wake?.({ value: undefined, done: true });
        connection.wake = null;
        closed += 1;
      }
    }
    return closed;
  }

  /**
   * Which active nodes this connection wants `research.turn.*` for and,
   * when `treeIds` is given, which threads it has open. The caller has
   * checked that the user may read each of `treeIds`. Repeating the same
   * `treeIds` renews presence.
   */
  setInterest(
    userId: string,
    connectionId: string,
    nodeIds: readonly string[],
    treeIds?: readonly string[],
  ): boolean {
    const connection = this.#byUser.get(userId)?.get(connectionId);
    if (!connection) {
      return false;
    }
    connection.interest = new Set(nodeIds);
    if (treeIds !== undefined) {
      const at = this.#now();
      const before = new Set(connection.openTrees.keys());
      connection.openTrees = new Map(treeIds.slice(0, MAX_OPEN_TREES).map((id) => [id, at]));
      for (const treeId of new Set([...before, ...connection.openTrees.keys()])) {
        this.#announcePresence(treeId);
      }
    }
    return true;
  }

  /** Whether `userId` is in the thread's audience now: its owner, a
   * member, or anyone while it is public. Without a directory, everyone. */
  #inAudience(audience: TreeAudience | null | undefined, userId: string): boolean {
    if (audience === undefined) return true;
    if (audience === null) return false;
    return audience.public || audience.ownerId === userId || audience.memberIds.includes(userId);
  }

  /** The people with `treeId` open, each once, in user id order. Only
   * people who may still read the thread are listed: a declaration made
   * before the thread turned private, or before its reader was removed, is
   * not presence. */
  viewers(treeId: string): ThreadViewer[] {
    const at = this.#now();
    const audience = this.#directory ? this.#directory.audience(treeId) : undefined;
    const ids = new Set<string>();
    for (const [userId, connections] of this.#byUser) {
      if (!this.#inAudience(audience, userId)) continue;
      for (const connection of connections.values()) {
        const seen = connection.openTrees.get(treeId);
        if (!connection.closed && seen !== undefined && at - seen <= PRESENCE_TTL_MS) {
          ids.add(userId);
        }
      }
    }
    return [...ids]
      .sort()
      .flatMap(
        (userId) =>
          this.#directory?.viewer(userId) ?? [
            { userId, login: userId, name: null, avatarUrl: null },
          ],
      );
  }

  /** Drops open-thread declarations older than `PRESENCE_TTL_MS` and
   * announces the threads whose viewers changed. The server calls it on a
   * timer. */
  expirePresence(): void {
    const at = this.#now();
    const touched = new Set<string>();
    for (const connections of this.#byUser.values()) {
      for (const connection of connections.values()) {
        for (const [treeId, seen] of connection.openTrees) {
          if (at - seen > PRESENCE_TTL_MS) {
            connection.openTrees.delete(treeId);
            touched.add(treeId);
          }
        }
      }
    }
    for (const treeId of touched) this.#announcePresence(treeId);
  }

  /**
   * Drops the open-thread declarations of people outside the thread's
   * audience now, and announces the thread's presence if it changed. Called
   * after a change that takes readers away: the thread turned private, a
   * member left or was removed, the owner moved it to the Trash or deleted
   * it. Their connections stop receiving its events through the declaration.
   */
  refreshAudience(treeId: string): void {
    const audience = this.#directory ? this.#directory.audience(treeId) : undefined;
    for (const [userId, connections] of this.#byUser) {
      if (this.#inAudience(audience, userId)) continue;
      for (const connection of connections.values()) connection.openTrees.delete(treeId);
    }
    this.#announcePresence(treeId);
  }

  /**
   * Delivers an event to the connections that declared `treeId` open and
   * belong to nobody in `except`, whatever the audience is now: how readers
   * of a public thread who are not members hear that it turned private or
   * was deleted, after the change that took it from them. Call it before
   * `refreshAudience`, which drops those declarations.
   */
  emitToOpenReaders(treeId: string, event: SessionEvent, except: readonly string[] = []): void {
    const skipped = new Set(except);
    for (const [userId, connections] of [...this.#byUser]) {
      if (skipped.has(userId)) continue;
      for (const connection of [...connections.values()]) {
        if (connection.openTrees.has(treeId)) this.#deliver(connection, event);
      }
    }
  }

  #announcePresence(treeId: string): void {
    const viewers = this.viewers(treeId);
    const key = viewers.map((viewer) => viewer.userId).join(",");
    if ((this.#presence.get(treeId) ?? "") === key) {
      return;
    }
    if (key === "") this.#presence.delete(treeId);
    else this.#presence.set(treeId, key);
    this.emitToTree(treeId, sessionEvent("research.presence.changed", { treeId, viewers }));
  }

  /**
   * Delivers a thread's event to its audience: every connection of its
   * owner and members and, for a public thread, every connection that
   * declared it open. `research.turn.*` still reaches only the connections
   * interested in the node. `also` names people outside the audience who
   * must get it too (the actor of a change that removed them).
   */
  emitToTree(
    treeId: string,
    event: SessionEvent,
    also: readonly string[] = [],
    except: readonly string[] = [],
  ): void {
    const audience = this.#directory?.audience(treeId) ?? null;
    const users = new Set<string>(also);
    if (audience) {
      users.add(audience.ownerId);
      for (const id of audience.memberIds) users.add(id);
    }
    const skipped = new Set(except);
    for (const userId of users) {
      if (!skipped.has(userId)) this.emit(userId, event);
    }
    if (audience?.public !== true) {
      return;
    }
    // Other signed-in readers of a public thread, through the connections
    // that declared it open.
    const filtered = event.type.startsWith(INTEREST_FILTERED_PREFIX);
    const nodeId = filtered ? eventNodeId(event) : null;
    for (const [userId, connections] of [...this.#byUser]) {
      if (users.has(userId) || skipped.has(userId)) continue;
      for (const connection of [...connections.values()]) {
        if (!connection.openTrees.has(treeId)) continue;
        if (filtered && (nodeId === null || !connection.interest.has(nodeId))) continue;
        this.#deliver(connection, event);
      }
    }
  }

  /**
   * Delivers an event to every connection of `userId`. Call it after the
   * transaction that produced the event has committed, never inside it: a
   * client that refetches on the event must not race the write it describes.
   */
  emit(userId: string, event: SessionEvent): void {
    const connections = this.#byUser.get(userId);
    if (!connections) {
      return;
    }
    const filtered = event.type.startsWith(INTEREST_FILTERED_PREFIX);
    const nodeId = filtered ? eventNodeId(event) : null;
    for (const connection of [...connections.values()]) {
      if (filtered && (nodeId === null || !connection.interest.has(nodeId))) {
        continue;
      }
      this.#deliver(connection, event);
    }
  }

  /** `emit` to each of `userIds` once. */
  emitToUsers(userIds: Iterable<string>, event: SessionEvent): void {
    for (const userId of new Set(userIds)) this.emit(userId, event);
  }

  emitAll(event: SessionEvent): void {
    for (const connections of [...this.#byUser.values()]) {
      for (const connection of [...connections.values()]) this.#deliver(connection, event);
    }
  }

  #deliver(connection: Connection, event: SessionEvent): void {
    if (connection.closed) {
      return;
    }
    const wake = connection.wake;
    if (wake) {
      connection.wake = null;
      wake({ value: event, done: false });
      return;
    }
    if (connection.queue.length >= MAX_QUEUED_EVENTS) {
      connection.closed = true;
      this.#unregister(connection);
      return;
    }
    connection.queue.push(event);
  }

  connectionCount(userId?: string): number {
    if (userId !== undefined) {
      return this.#byUser.get(userId)?.size ?? 0;
    }
    let total = 0;
    for (const connections of this.#byUser.values()) {
      total += connections.size;
    }
    return total;
  }

  /** Closes active SSE connections on SIGTERM to prompt client reconnection. */
  closeAll(): void {
    for (const connections of [...this.#byUser.values()]) {
      for (const connection of [...connections.values()]) {
        connection.closed = true;
        this.#unregister(connection);
        connection.wake?.({ value: undefined, done: true });
        connection.wake = null;
      }
    }
  }
}
