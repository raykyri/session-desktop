// Event fan-out (`03-api-and-events.md` §3).
//
// Manages server-sent event dispatch across in-process user connections.
// There is no replay buffer; clients that miss events must refetch state
// (`05-run-lifecycle-and-streaming.md` §4). Connections whose queue overflows
// are closed to trigger client resynchronization rather than silently dropping events.
//
// Thread events (`emitToTree`) route to thread audience members (owners,
// collaborators, and active viewers of public threads declared via `setInterest`).
// Active viewer state also drives presence tracking, expiring if not renewed
// within `PRESENCE_TTL_MS` or when connections terminate. Guest sessions do
// not establish event connections.

import type { SessionEvent, ThreadViewer } from "@session/shared";

/** Run deltas are dispatched only to connections that registered interest in the node
 * (`events.setInterest`); all other events are broadcast to all user connections. */
const INTEREST_FILTERED_PREFIX = "research.turn.";

/** Disconnects clients whose pending event queue exceeds MAX_QUEUED_EVENTS to bound server memory. */
const MAX_QUEUED_EVENTS = 2048;

export interface Subscription {
  connectionId: string;
  /** Yields until `close()`, an overflow, or the end of its session. */
  events: AsyncIterableIterator<SessionEvent>;
  close(): void;
  /** True once `closeSession` terminated the connection because the associated
   * session was signed out, deleted, or expired. */
  sessionEnded(): boolean;
}

export interface SubscribeOptions {
  /** Session ID associated with this connection (`auth.hashSessionToken` of
   * the cookie). Used by `closeSession` to terminate connections for a specific
   * session; null if unauthenticated. */
  sessionId?: string | null;
}

export function sessionEvent(type: string, payload: Record<string, unknown>): SessionEvent {
  return { type, payload, timestamp: Date.now() };
}

/** Extracts the node ID from a run event payload, if present. */
function eventNodeId(event: SessionEvent): string | null {
  const nodeId = event.payload["nodeId"];
  return typeof nodeId === "string" ? nodeId : null;
}

/** How long a declared open thread counts as viewed without a renewal. */
export const PRESENCE_TTL_MS = 90_000;

/** Maximum number of threads a single connection may declare open. */
export const MAX_OPEN_TREES = 20;

/** Who may receive a thread's events (`sharing.audience`). */
export interface TreeAudience {
  ownerId: string;
  memberIds: readonly string[];
  /** Other signed-in readers that declared the thread open receive it too. */
  public: boolean;
}

/** Database directory interface providing thread audience and viewer presence
 * metadata. If absent, `emitToTree` does not dispatch events. */
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
  /** Threads open on this connection, mapped to last interest renewal timestamp. */
  openTrees: Map<string, number>;
  queue: SessionEvent[];
  /** Resolver called when the next event is queued. */
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

  /** Sets the directory used by `emitToTree` during server initialization. */
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
   * Closes every connection opened with `sessionId`: called when that session
   * is signed out or deleted, or when the periodic check detects expiry. The
   * stream's iterator completes with `sessionEnded()` true, which
   * `events.subscribe` translates to `UNAUTHORIZED`. Returns the number of
   * closed connections.
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
   * Registers node IDs for filtered `research.turn.*` delivery and optional
   * open thread IDs for presence tracking. Callers must verify user read
   * permissions for `treeIds`. Repeating `treeIds` renews presence TTL.
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

  /** Checks whether `userId` belongs to the thread audience (owner, member,
   * or any user if public). Returns true if no directory is configured. */
  #inAudience(audience: TreeAudience | null | undefined, userId: string): boolean {
    if (audience === undefined) return true;
    if (audience === null) return false;
    return audience.public || audience.ownerId === userId || audience.memberIds.includes(userId);
  }

  /** Active viewers of `treeId`, deduplicated and sorted by user ID. Only
   * users with current read access are returned; declarations recorded
   * before access was revoked or before the thread was made private are
   * excluded. */
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
   * Removes open-thread declarations for users no longer in the thread's
   * audience, and announces presence changes if any occurred. Called after
   * permissions changes (e.g. thread set to private, member removed, or
   * thread deleted) so ineligible connections stop receiving events.
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
   * Delivers an event to connections that declared `treeId` open and do not
   * belong to any user in `except`, regardless of current audience. Used to
   * notify active viewers when a public thread becomes private or is deleted.
   * Must be called before `refreshAudience` removes those declarations.
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
   * Delivers a thread event to its audience: connections belonging to the
   * owner and members, plus connections of any user who declared the thread
   * open if public. `research.turn.*` events filter by node interest.
   * `also` specifies additional users outside the audience to receive the
   * event (such as an actor who removed themselves).
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
   * Delivers an event to every connection of `userId`. Must be called after
   * the transaction producing the event has committed to prevent client
   * refetches from racing uncommitted database writes.
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

  /** Emits an event once to each user in `userIds`. */
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
