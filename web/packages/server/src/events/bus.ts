// Event fan-out (`03-api-and-events.md` §3).
//
// One process, so the bus is a map from user id to that user's open
// connections. There is no replay buffer: a client that misses events
// refetches (`05-run-lifecycle-and-streaming.md` §4), which is why a
// connection whose queue overflows is closed rather than trimmed silently —
// closing makes the client resynchronize, trimming would leave it with a hole
// it cannot see.

import type { SessionEvent } from "@session/shared";

/** Run deltas go only to connections that asked for the node
 * (`events.setInterest`); everything else goes to every connection. */
const INTEREST_FILTERED_PREFIX = "research.turn.";

/** A slow reader is disconnected rather than allowed to grow without bound. */
const MAX_QUEUED_EVENTS = 2048;

export interface Subscription {
  connectionId: string;
  /** Yields until `close()` or an overflow. */
  events: AsyncIterableIterator<SessionEvent>;
  close(): void;
}

export function sessionEvent(type: string, payload: Record<string, unknown>): SessionEvent {
  return { type, payload, timestamp: Date.now() };
}

/** The node a run event is about, when it carries one. */
function eventNodeId(event: SessionEvent): string | null {
  const nodeId = event.payload["nodeId"];
  return typeof nodeId === "string" ? nodeId : null;
}

interface Connection {
  id: string;
  userId: string;
  interest: Set<string>;
  queue: SessionEvent[];
  /** Set while the iterator is parked waiting for the next event. */
  wake: ((event: IteratorResult<SessionEvent>) => void) | null;
  closed: boolean;
}

export class EventBus {
  readonly #byUser = new Map<string, Map<string, Connection>>();

  #register(connection: Connection): void {
    let connections = this.#byUser.get(connection.userId);
    if (!connections) {
      connections = new Map();
      this.#byUser.set(connection.userId, connections);
    }
    // Two tabs can restore the same persisted connection id; the older stream
    // is ended rather than left registered under an id it no longer owns.
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
  }

  subscribe(userId: string, connectionId: string, signal?: AbortSignal): Subscription {
    const connection: Connection = {
      id: connectionId,
      userId,
      interest: new Set(),
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

    return { connectionId, events, close };
  }

  /** Which active nodes this connection wants `research.turn.*` for. */
  setInterest(userId: string, connectionId: string, nodeIds: readonly string[]): boolean {
    const connection = this.#byUser.get(userId)?.get(connectionId);
    if (!connection) {
      return false;
    }
    connection.interest = new Set(nodeIds);
    return true;
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

  /** `SIGTERM`: close every SSE connection so clients reconnect to the next
   * boot rather than sitting on a dead socket (`05` §7). */
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
