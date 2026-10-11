import { recordRemoteStartup, forgetRemoteStartup, forgetRemotePane, rememberRemoteStartupConnection } from "../lib/remoteStartup";
import { parseRemoteConnection } from "../lib/remoteConnection";
import { useEffect } from "react";
import type { Dispatch, SetStateAction } from "react";
import {
  acknowledgeInterfaceHealthProbe,
  listAgents,
  listGroups,
  listPanes,
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
import type { ActiveWorkspace, AgentInfo, GroupInfo, PaneInfo, SessionEvent } from "../types";

// Accumulate events for one frame, then process them in arrival order in one
// synchronous block. This limits sustained streams to one React render per
// window. Interactive events use the same queue so they run after earlier
// pane and agent updates, with at most one frame of added latency.
const EVENT_COALESCE_MS = 16;

// The backend event stream drives most of the app's live state. This hook owns
// the single global subscription, created once with empty dependencies. State
// setters are stable, and callbacks read current state through refs.
interface UseSessionEventsHandlers {
  setPanes: Dispatch<SetStateAction<PaneInfo[]>>;
  setExitPreflightRequest: Dispatch<SetStateAction<ExitPreflightRequest | null>>;
  setAgents: Dispatch<SetStateAction<AgentInfo[]>>;
  setGroups: Dispatch<SetStateAction<GroupInfo[]>>;
  // Binds a browser-overlay URL to a pane (the backend emits the fully-formed URL).
  openBrowserOverlay: (
    paneId: string,
    url: string,
    sandbox?: boolean,
    artifactId?: string | null,
  ) => void;
  onAgentSpawned?: (agent: AgentInfo, paneId: string | null, source: string | null) => void;
  onAgentPromptSubmitted?: (agentId: string, prompt: string) => void;
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

function agentPromptSubmittedText(payload: Record<string, unknown>): string | null {
  const hookPayload = payload.payload;
  return stringField(hookPayload, "prompt") ?? stringField(hookPayload, "input");
}

export function useSessionEvents(handlers: UseSessionEventsHandlers) {
  const {
    setPanes,
    setExitPreflightRequest,
    setAgents,
    setGroups,
    openBrowserOverlay,
    onAgentSpawned,
    onAgentPromptSubmitted,
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
    // Same idea for pane-list refetches (a fork adds a pane backend-side).
    let panesRefreshSeq = 0;
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
      if (event.type === "pane.removed" && event.paneId) {
        const exitedPaneId = event.paneId;
        setPanes((current) => {
          forgetRemotePane(exitedPaneId);
          return current.filter((pane) => pane.id !== exitedPaneId);
        });
      }
      if (event.type === "pane.created" || event.type === "pane.renamed") {
        const seq = (panesRefreshSeq += 1);
        void listPanes()
          .then((latest) => {
            if (!disposed && seq === panesRefreshSeq) {
              setPanes(latest);
            }
          })
          .catch(() => undefined);
      }
      if (event.type === "pane.remote_connection" && event.paneId) {
        const connection = parseRemoteConnection(event.payload.connection);
        if (connection) {
          const paneId = event.paneId;
          rememberRemoteStartupConnection(paneId, connection);
          if (connection.state === "connected") recordRemoteStartup(paneId, "ready");
          if (connection.state === "failed") forgetRemoteStartup(paneId);
          setPanes((current) => current.map((pane) =>
            pane.id === paneId ? { ...pane, remoteConnection: connection } : pane));
        }
      }
      if (event.type === "pane.cwd_changed" && event.paneId) {
        // A shell tab reported a directory change (the user cd'd). The backend has
        // already persisted it for restart recovery; patch the live pane so the tab
        // path and context-menu working dir track the current directory instead of
        // lagging at the spawn-time cwd until the next full pane-list load. The
        // payload also carries the freshly resolved workspace observation so the
        // worktree badge updates in the same step.
        const cwdPaneId = event.paneId;
        const nextCwd = event.payload.cwd;
        if (typeof nextCwd === "string") {
          const rawWorkspace = event.payload.activeWorkspace;
          const nextWorkspace =
            rawWorkspace && typeof rawWorkspace === "object"
              ? (rawWorkspace as ActiveWorkspace)
              : null;
          setPanes((current) =>
            current.map((pane) =>
              pane.id === cwdPaneId
                ? { ...pane, cwd: nextCwd, activeWorkspace: nextWorkspace }
                : pane,
            ),
          );
        }
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
        const paneCount =
          typeof event.payload.paneCount === "number" ? event.payload.paneCount : 1;
        const researchRunCount =
          typeof event.payload.researchRunCount === "number"
            ? event.payload.researchRunCount
            : 0;
        setExitPreflightRequest((current) => ({
          paneCount,
          researchRunCount,
          nonce: (current?.nonce ?? 0) + 1,
        }));
      }
      if (
        event.type.startsWith("agent.") &&
        event.type !== "agent.shell_job_state_changed" &&
        event.type !== "agent.shell_job_removed"
      ) {
        // Status events include the updated agent: apply it directly so a busy
        // agent's stream of hook events doesn't refetch and replace the entire list
        // (with the re-renders and ordering hazards that caused). Events without an
        // agent fall back to a sequenced refetch.
        const updatedAgent = event.payload.agent;
        if (isAgentInfo(updatedAgent)) {
          setAgents((current) => upsertAgent(current, updatedAgent));
          if (event.type === "agent.spawned") {
            onAgentSpawned?.(
              updatedAgent,
              event.paneId ?? updatedAgent.paneId ?? null,
              stringField(event.payload, "source"),
            );
          }
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
      if (event.agentId && event.type === "agent.prompt_submitted") {
        const prompt = agentPromptSubmittedText(event.payload);
        if (prompt) {
          onAgentPromptSubmitted?.(event.agentId, prompt);
        }
      }
      if (event.type === "browser.open" && event.paneId) {
        const url = event.payload.url;
        if (typeof url === "string") {
          const artifactId = event.payload.artifactId;
          openBrowserOverlay(
            event.paneId,
            url,
            event.payload.sandbox === true,
            typeof artifactId === "string" ? artifactId : null,
          );
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
      if (
        event.type === "agent.forked" ||
        (event.type === "agent.spawned" &&
          event.payload.source !== "shell")
      ) {
        // The fork — or a queue-dispatched new-session or research-root spawn —
        // created a new pane backend-side with no frontend caller holding it;
        // refetch the ordered list so the newly placed tab appears
        // without changing focus.
        const seq = (panesRefreshSeq += 1);
        void listPanes()
          .then((latest) => {
            if (!disposed && seq === panesRefreshSeq) {
              setPanes(latest);
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
        // terminal.shortcut / app.shortcut event actually reaches this hook.
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
