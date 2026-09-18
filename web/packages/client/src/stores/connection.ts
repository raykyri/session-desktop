// SSE connection status (07 §4.2). Drives the subtle indicator in the stage
// header and, while the stream is down, the snapshot-poll fallback for
// displayed active nodes (05 §9).

import { create } from "zustand";

export type ConnectionStatus = "connecting" | "open" | "closed";

/** After this long without a connection the document views start polling
 * snapshots instead of waiting for deltas (05 §9). */
export const CONNECTION_FALLBACK_DELAY_MS = 10_000;

export interface ConnectionState {
  status: ConnectionStatus;
  lastEventId: string | null;
  /** When the current disconnection began; null while connected. */
  disconnectedSince: number | null;
  setStatus: (status: ConnectionStatus, now?: number) => void;
  setLastEventId: (lastEventId: string | null) => void;
  shouldPollSnapshots: (now?: number) => boolean;
}

export const useConnectionStore = create<ConnectionState>()((set, get) => ({
  status: "connecting",
  lastEventId: null,
  disconnectedSince: null,

  setStatus: (status, now = Date.now()) =>
    set((state) => ({
      status,
      disconnectedSince: status === "open" ? null : (state.disconnectedSince ?? now),
    })),
  setLastEventId: (lastEventId) => set({ lastEventId }),
  shouldPollSnapshots: (now = Date.now()) => {
    const { status, disconnectedSince } = get();
    if (status === "open" || disconnectedSince === null) return false;
    return now - disconnectedSince >= CONNECTION_FALLBACK_DELAY_MS;
  },
}));
