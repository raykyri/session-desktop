import { useEffect } from "react";
import type { Dispatch, SetStateAction } from "react";
import {
  acknowledgeInterfaceHealthProbe,
  listAgents,
  listGroups,
  listenToEvents,
  markEventsListenerReady,
} from "../lib/api";
import { isAgentInfo, upsertAgent } from "../lib/appHelpers";
import { parseAppShortcutCommand, type AppShortcutCommand } from "../lib/appShortcuts";
import {
  publishResearchContentChanged,
  RESEARCH_CONTENT_CHANGED_EVENT,
} from "../lib/researchContentRefresh";
import type { ExitPreflightRequest } from "../appTypes";
import type { AgentInfo, GroupInfo, SessionEvent } from "../types";

// Accumulate events for one frame, then process them in arrival order in one
// synchronous block. This limits sustained streams to one React render per
// window. Interactive events use the same queue so they run after earlier
// agent updates, with at most one frame of added latency.
const EVENT_COALESCE_MS = 16;

// The backend event stream drives most of the app's live state. This hook owns
// the single global subscription, created once with empty dependencies. State
// setters are stable, and callbacks read current state through refs.
interface UseSessionEventsHandlers {
  setExitPreflightRequest: Dispatch<SetStateAction<ExitPreflightRequest | null>>;
  setAgents: Dispatch<SetStateAction<AgentInfo[]>>;
  setGroups: Dispatch<SetStateAction<GroupInfo[]>>;
  // Binds a browser-overlay URL to its owner (the backend emits the fully-formed URL).
  openBrowserOverlay: (ownerId: string, url: string, sandbox?: boolean) => void;
  onAppShortcut?: (command: AppShortcutCommand, repeat: boolean) => void;
  onBrowserEscapeRequested?: () => void;
  onResearchChanged?: (event: SessionEvent) => void;
  onUserNotificationRequested?: (event: SessionEvent) => void;
}

function stringField(value: unknown, field: string): string | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const fieldValue = (value as Record<string, unknown>)[field];
  return typeof fieldValue === "string" ? fieldValue : null;
}

export function useSessionEvents(handlers: UseSessionEventsHandlers) {
  const {
    setExitPreflightRequest,
    setAgents,
    setGroups,
    openBrowserOverlay,
    onAppShortcut,
    onBrowserEscapeRequested,
    onResearchChanged,
    onUserNotificationRequested,
  } = handlers;

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    // Sequences full agent-list refetches so a slow response can't overwrite a
    // newer snapshot. Only bumped on events that don't already carry the agent.
    let agentRefreshSeq = 0;
    let groupsRefreshSeq = 0;
    const handleEvent = (event: SessionEvent) => {
      if (event.type === "app.interface_health_probe") {
        const generation = event.payload.generation;
        if (typeof generation === "number" && Number.isSafeInteger(generation)) {
          // Waiting for two animation frames makes the acknowledgement prove
          // more than a live JavaScript event loop: WebKit must still be able
          // to schedule a paint after suspension or GPU-process restarts. If
          // rAF remains blocked, the native watchdog reloads the document.
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              void acknowledgeInterfaceHealthProbe(generation).catch(() => undefined);
            });
          });
        }
      }
      if (event.type === RESEARCH_CONTENT_CHANGED_EVENT) {
        // A per-turn-write signal for open thread pages; it carries no
        // research state for the App-level reducer.
        const nodeId = stringField(event.payload, "nodeId");
        if (nodeId) {
          publishResearchContentChanged(nodeId);
        }
      } else if (event.type.startsWith("research.")) {
        onResearchChanged?.(event);
      }
      if (event.type === "app.notification_requested") {
        onUserNotificationRequested?.(event);
      }
      if (event.type === "app.shortcut") {
        const command = parseAppShortcutCommand(event.payload.command);
        if (command !== null) {
          onAppShortcut?.(command, event.payload.repeat === true);
        }
      }
      if (event.type === "browser.escape_requested") {
        onBrowserEscapeRequested?.();
      }
      if (event.type === "app.exit_confirmation_requested") {
        const researchRunCount =
          typeof event.payload.researchRunCount === "number"
            ? event.payload.researchRunCount
            : 0;
        setExitPreflightRequest((current) => ({
          researchRunCount,
          nonce: (current?.nonce ?? 0) + 1,
        }));
      }
      if (event.type.startsWith("agent.")) {
        // Status events include the updated agent: apply it directly so a busy
        // agent's stream of hook events doesn't refetch and replace the entire list
        // (with the re-renders and ordering hazards that caused). Events without an
        // agent fall back to a sequenced refetch.
        const updatedAgent = event.payload.agent;
        if (isAgentInfo(updatedAgent)) {
          setAgents((current) => upsertAgent(current, updatedAgent));
        } else {
          const seq = (agentRefreshSeq += 1);
          void listAgents()
            .then((list) => {
              if (!disposed && seq === agentRefreshSeq) {
                setAgents(list);
              }
            })
            .catch(() => undefined);
        }
      }
      if (event.type === "browser.open" && event.paneId) {
        const url = event.payload.url;
        if (typeof url === "string") {
          openBrowserOverlay(event.paneId, url, event.payload.sandbox === true);
        }
      }
      if (
        event.type === "group.created" ||
        event.type === "group.updated" ||
        event.type === "group.removed"
      ) {
        const seq = (groupsRefreshSeq += 1);
        void listGroups()
          .then((latest) => {
            if (!disposed && seq === groupsRefreshSeq) {
              setGroups(latest);
            }
          })
          .catch(() => undefined);
      }
    };

    const pendingEvents: SessionEvent[] = [];
    let coalesceTimer: number | null = null;
    const flushPendingEvents = () => {
      coalesceTimer = null;
      if (disposed || pendingEvents.length === 0) {
        return;
      }
      const batch = pendingEvents.splice(0, pendingEvents.length);
      // Every setState across the batch runs in this one synchronous block, so
      // React commits a single render for the whole burst.
      for (const event of batch) {
        handleEvent(event);
      }
    };

    void listenToEvents((event) => {
      if (disposed) {
        return;
      }
      pendingEvents.push(event);
      if (coalesceTimer === null) {
        coalesceTimer = window.setTimeout(flushPendingEvents, EVENT_COALESCE_MS);
      }
    }).then((cleanup) => {
      if (disposed) {
        cleanup();
      } else {
        unlisten = cleanup;
        // Unblock the native shortcut classifiers: from here on an emitted
        // app.shortcut event actually reaches this hook.
        void markEventsListenerReady().catch(() => undefined);
      }
    });

    return () => {
      disposed = true;
      if (coalesceTimer !== null) {
        clearTimeout(coalesceTimer);
      }
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
