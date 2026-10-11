import type { ResearchNodeContent } from "../types";

/** Backend event emitted after every write to a research agent's live turns.
 * Payload: `{ nodeId }`. It is routed to `publishResearchContentChanged`
 * instead of the research state reducer: it changes no tree or node state. */
export const RESEARCH_CONTENT_CHANGED_EVENT = "research.content.changed";

type ContentChangedListener = (nodeId: string) => void;

const contentChangedListeners = new Set<ContentChangedListener>();

export function publishResearchContentChanged(nodeId: string) {
  for (const listener of [...contentChangedListeners]) {
    listener(nodeId);
  }
}

/** Calls `listener` with the node id of every `research.content.changed`
 * event. Returns the unsubscribe function. */
export function subscribeResearchContentChanged(listener: ContentChangedListener): () => void {
  contentChangedListeners.add(listener);
  return () => {
    contentChangedListeners.delete(listener);
  };
}

export interface RefreshTimers {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ContentRefresh {
  /** Asks for a fetch. Requests made while a fetch is in flight, or within
   * `minIntervalMs` of the last fetch's start, collapse into one trailing
   * fetch. */
  request(): void;
  /** Drops any pending trailing fetch; later requests are ignored. */
  dispose(): void;
}

/** Runs `fetch` at most once at a time and starts fetches at least
 * `minIntervalMs` apart, without dropping the last request: a request that
 * arrives during a fetch or inside the interval schedules exactly one
 * trailing fetch. */
export function createContentRefresh(
  fetch: () => Promise<unknown>,
  minIntervalMs: number,
  timers: RefreshTimers,
): ContentRefresh {
  let disposed = false;
  let pending = false;
  let inFlight = false;
  let timer: unknown = null;
  let lastStartedAt = Number.NEGATIVE_INFINITY;

  const pump = () => {
    if (disposed || !pending || inFlight || timer !== null) {
      return;
    }
    const wait = lastStartedAt + minIntervalMs - timers.now();
    if (wait > 0) {
      timer = timers.setTimeout(() => {
        timer = null;
        pump();
      }, wait);
      return;
    }
    pending = false;
    inFlight = true;
    lastStartedAt = timers.now();
    let settled: Promise<unknown>;
    try {
      settled = fetch();
    } catch (err) {
      settled = Promise.reject(err);
    }
    void settled
      .catch(() => undefined)
      .then(() => {
        inFlight = false;
        pump();
      });
  };

  return {
    request() {
      if (disposed) {
        return;
      }
      pending = true;
      pump();
    },
    dispose() {
      disposed = true;
      pending = false;
      if (timer !== null) {
        timers.clearTimeout(timer);
        timer = null;
      }
    },
  };
}

/** `next`, with the parts that are content-equal to `previous` replaced by
 * the previous objects; `previous` itself when nothing changed. Keeping the
 * previous object lets a refetch of unchanged content skip the state update
 * and the re-render it would cause, and keeps unchanged turns'
 * identity-keyed memos valid when only the streaming turn changed. */
export function reuseUnchangedContent(
  previous: ResearchNodeContent | undefined,
  next: ResearchNodeContent,
): ResearchNodeContent {
  if (!previous) {
    return next;
  }
  const node = JSON.stringify(previous.node) === JSON.stringify(next.node) ? previous.node : next.node;
  const priorById = new Map(previous.turns.map((turn) => [turn.id, turn]));
  const turns = next.turns.map((turn) => {
    const prior = priorById.get(turn.id);
    return prior &&
      prior.blocks.length === turn.blocks.length &&
      JSON.stringify(prior) === JSON.stringify(turn)
      ? prior
      : turn;
  });
  const sameTurns =
    turns.length === previous.turns.length &&
    turns.every((turn, index) => turn === previous.turns[index]);
  if (
    node === previous.node &&
    sameTurns &&
    next.sourceError === previous.sourceError &&
    next.responseRevision === previous.responseRevision
  ) {
    return previous;
  }
  return { ...next, node, turns: sameTurns ? previous.turns : turns };
}
