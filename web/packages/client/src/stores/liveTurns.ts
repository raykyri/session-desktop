// Streaming buffers for the nodes a client is watching (07 §4.3,
// 05-run-lifecycle-and-streaming.md §4 and §9).
//
// Deltas never touch the query cache: a run at 30 events/s would invalidate
// list queries thirty times a second for content only one subtree renders.
// Instead `useNodeContent` seeds this store from the snapshot and the event
// bridge feeds it ordered deltas.
//
// The ordering rule is the whole point of the store: apply only
// `seq === lastSeq + 1`, silently drop anything at or below `lastSeq` (a
// replay after reconnect), and on a gap set `gap` so the view refetches the
// snapshot instead of rendering text with a hole in it.

import type { Turn } from "@session/shared";
import { create } from "zustand";

export type LiveTurnStatus = "idle" | "running" | "thinking" | "finished";

export interface LiveNodeState {
  /** Committed turns, in order, as they arrive from `research.turn.committed`. */
  turns: Turn[];
  /** The text of the turn currently being produced, if any. */
  inFlightText: string;
  inFlightTurnId: string | null;
  /** Highest applied sequence number; -1 before a snapshot seeds the node. */
  lastSeq: number;
  status: LiveTurnStatus;
  /** Set when a delta arrived with `seq > lastSeq + 1`. The view refetches the
   * snapshot and calls `seed` again, which clears it. */
  gap: boolean;
}

export type RunEvent =
  | { type: "run.started"; nodeId: string; seq: number }
  | { type: "run.thinking"; nodeId: string; seq: number }
  | { type: "turn.delta"; nodeId: string; seq: number; text: string; turnId?: string | null }
  | { type: "turn.committed"; nodeId: string; seq: number; turn: Turn }
  | { type: "run.finished"; nodeId: string; seq: number };

export interface LiveTurnsState {
  byNode: Record<string, LiveNodeState>;
  /** Installs a snapshot: `research.getNodeContent` returns turns plus the seq
   * they are current as of, which becomes the new ordering baseline. */
  seed: (
    nodeId: string,
    snapshot: { turns: Turn[]; inFlightText?: string; seq: number; status?: LiveTurnStatus },
  ) => void;
  applyRunEvent: (event: RunEvent) => void;
  /** Drops a node's buffer once the durable snapshot has replaced it. */
  clear: (nodeId: string) => void;
  clearAll: () => void;
  nodeState: (nodeId: string) => LiveNodeState | undefined;
  hasGap: (nodeId: string) => boolean;
}

export const EMPTY_LIVE_NODE: LiveNodeState = {
  turns: [],
  inFlightText: "",
  inFlightTurnId: null,
  lastSeq: -1,
  status: "idle",
  gap: false,
};

function reduce(current: LiveNodeState, event: RunEvent): LiveNodeState {
  switch (event.type) {
    case "run.started":
      return { ...current, status: "running", inFlightText: "", inFlightTurnId: null };
    case "run.thinking":
      return { ...current, status: "thinking" };
    case "turn.delta":
      return {
        ...current,
        status: "running",
        inFlightTurnId: event.turnId ?? current.inFlightTurnId,
        // A delta for a different turn id restarts the buffer rather than
        // appending to the previous turn's tail.
        inFlightText:
          event.turnId && current.inFlightTurnId && event.turnId !== current.inFlightTurnId
            ? event.text
            : current.inFlightText + event.text,
      };
    case "turn.committed":
      return {
        ...current,
        turns: [...current.turns, event.turn],
        inFlightText: "",
        inFlightTurnId: null,
      };
    case "run.finished":
      return { ...current, status: "finished", inFlightText: "", inFlightTurnId: null };
  }
}

export const useLiveTurnsStore = create<LiveTurnsState>()((set, get) => ({
  byNode: {},

  seed: (nodeId, snapshot) =>
    set((state) => ({
      byNode: {
        ...state.byNode,
        [nodeId]: {
          turns: snapshot.turns,
          inFlightText: snapshot.inFlightText ?? "",
          inFlightTurnId: null,
          lastSeq: snapshot.seq,
          status: snapshot.status ?? "idle",
          gap: false,
        },
      },
    })),

  applyRunEvent: (event) =>
    set((state) => {
      const current = state.byNode[event.nodeId] ?? EMPTY_LIVE_NODE;

      // Already applied, or replayed after a reconnect. Dropping is correct:
      // the buffer already contains this event's effect.
      if (event.seq <= current.lastSeq) return state;

      // A hole. Applying the event would render text with a piece missing, so
      // the buffer freezes and the flag tells the view to refetch the snapshot.
      if (current.lastSeq >= 0 && event.seq !== current.lastSeq + 1) {
        if (current.gap) return state;
        return { byNode: { ...state.byNode, [event.nodeId]: { ...current, gap: true } } };
      }

      const next = reduce(current, event);
      return {
        byNode: { ...state.byNode, [event.nodeId]: { ...next, lastSeq: event.seq, gap: false } },
      };
    }),

  clear: (nodeId) =>
    set((state) => {
      if (!(nodeId in state.byNode)) return state;
      const next = { ...state.byNode };
      delete next[nodeId];
      return { byNode: next };
    }),

  clearAll: () => set({ byNode: {} }),

  nodeState: (nodeId) => get().byNode[nodeId],
  hasGap: (nodeId) => get().byNode[nodeId]?.gap === true,
}));
