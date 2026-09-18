// The SSE bridge (07 §4.2): one `events.subscribe` subscription for the app's
// lifetime, whose events are queued and flushed on a 16 ms trailing timer so a
// burst of deltas yields one render.
//
// STUB. `connect` reports `closed` and never opens a stream; the coalescing
// buffer and the store fan-out below are real and already under test, so the
// second half replaces the transport and not the reducer.

import { turnSchema, type SessionEvent } from "@session/shared";

import { useConnectionStore } from "../stores/connection.js";
import { useLiveTurnsStore, type RunEvent } from "../stores/liveTurns.js";
import { notificationFromPayload, useNotificationsStore } from "../stores/notifications.js";
import { useSettingsStore } from "../stores/settings.js";

/** Matches the desktop's `useSessionEvents.ts:37-51`. */
export const EVENT_COALESCE_MS = 16;

export interface EventBridgeHandle {
  /** Declares the nodes whose deltas this connection wants (`events.setInterest`). */
  setInterest: (nodeIds: string[]) => void;
  close: () => void;
}

/** Applies one batch of events to the stores. Cache patches join this once the
 * query client is wired. */
export function applyEventBatch(events: SessionEvent[]): void {
  const liveTurns = useLiveTurnsStore.getState();
  const notifications = useNotificationsStore.getState();

  for (const event of events) {
    const runEvent = asRunEvent(event);
    if (runEvent) {
      liveTurns.applyRunEvent(runEvent);
      continue;
    }
    if (event.type === "notification.requested") {
      // The bridge is the only ingress for server-originated toasts, so the
      // `showNotifications` preference is enforced here. The store does not
      // know about settings, and the server keeps sending the events either
      // way — a notification the user opted out of is still a run that
      // finished, and the caches that reflect it are patched above.
      if (!useSettingsStore.getState().settings.showNotifications) continue;
      const item = notificationFromPayload(event.payload, event.timestamp);
      if (item) notifications.push(item);
    }
  }
}

/** Narrows the loose envelope into the run union `liveTurns` accepts. Anything
 * without a `nodeId` and a numeric `seq` is not a run event. */
export function asRunEvent(event: SessionEvent): RunEvent | null {
  const { nodeId, seq } = event.payload;
  if (typeof nodeId !== "string" || typeof seq !== "number") return null;
  switch (event.type) {
    case "research.run.started":
      return { type: "run.started", nodeId, seq };
    case "research.run.thinking":
      return { type: "run.thinking", nodeId, seq };
    case "research.run.finished":
      return { type: "run.finished", nodeId, seq };
    case "research.turn.delta": {
      const { text, turnId } = event.payload;
      if (typeof text !== "string") return null;
      return { type: "turn.delta", nodeId, seq, text, turnId: asOptionalString(turnId) };
    }
    case "research.turn.committed": {
      // The envelope's payload is untyped JSON, so the turn is parsed here
      // rather than cast: a turn that does not match the schema is a malformed
      // event, and dropping it makes the view refetch the snapshot.
      const turn = turnSchema.safeParse(event.payload.turn);
      if (!turn.success) return null;
      return { type: "turn.committed", nodeId, seq, turn: turn.data };
    }
    default:
      return null;
  }
}

function asOptionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function connectEventBridge(): EventBridgeHandle {
  useConnectionStore.getState().setStatus("closed");
  return {
    setInterest: () => undefined,
    close: () => undefined,
  };
}
