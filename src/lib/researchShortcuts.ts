// Cross-component channels for research-surface shortcuts. The app-level
// shortcut dispatcher lives in App.tsx while the follow-up composer belongs to
// ResearchThreadPage and the workspace menu's open state to ResearchWorkspaceSwitcher,
// so window events bridge those portaled surfaces back to their owners. Each
// target component is mounted at most once (the active thread page, the research
// sidebar's switcher), so the events carry no addressing detail.

const FOCUS_FOLLOWUPS_EVENT = "session:research-focus-followups";
const TOGGLE_WORKSPACE_MENU_EVENT = "session:research-toggle-workspace-menu";

/** Requests the mounted thread page to bring its follow-up composer into
 * view and focus it. No-op when no thread is on the research stage. */
export function requestResearchFollowupsFocus() {
  window.dispatchEvent(new CustomEvent(FOCUS_FOLLOWUPS_EVENT));
}

/** Subscribes the thread page to follow-up focus requests; returns the
 * unsubscribe function. */
export function listenToResearchFollowupsFocus(onFocus: () => void): () => void {
  const handler = () => onFocus();
  window.addEventListener(FOCUS_FOLLOWUPS_EVENT, handler);
  return () => window.removeEventListener(FOCUS_FOLLOWUPS_EVENT, handler);
}

/** Requests the research sidebar's workspace switcher to toggle its dropdown menu.
 * No-op outside research mode, where the switcher is unmounted. */
export function requestResearchWorkspaceMenuToggle() {
  window.dispatchEvent(new CustomEvent(TOGGLE_WORKSPACE_MENU_EVENT));
}

/** Subscribes the workspace switcher to menu toggle requests; returns the
 * unsubscribe function. */
export function listenToResearchWorkspaceMenuToggle(onToggle: () => void): () => void {
  const handler = () => onToggle();
  window.addEventListener(TOGGLE_WORKSPACE_MENU_EVENT, handler);
  return () => window.removeEventListener(TOGGLE_WORKSPACE_MENU_EVENT, handler);
}

const OPEN_NODE_EVENT = "session:research-open-node";

interface ResearchOpenNodeRequest {
  treeId: string;
  nodeId: string;
  /** False when back/forward replays a recorded visit: the thread page shows
   * the node without reporting a new visit. */
  record: boolean;
  /** Each column's selected message, ending with `nodeId` (a recorded
   * visit's); without it `nodeId`'s source path opens. */
  path?: readonly string[];
}

/** Asks the mounted thread page for `treeId` to show `nodeId`: its level, and
 * the levels before it, open as column pairs with the node selected. The app shell
 * also records the node in the navigation store, which covers the case where
 * no thread page for that tree is mounted yet. Returns whether a mounted
 * thread page selected the node (false when none shows the tree, or its
 * loaded tree does not have the node yet). */
export function requestResearchNodeOpen(
  treeId: string,
  nodeId: string,
  { record = true, path }: { record?: boolean; path?: readonly string[] } = {},
): boolean {
  const detail = { treeId, nodeId, record, path, handled: false };
  window.dispatchEvent(new CustomEvent(OPEN_NODE_EVENT, { detail }));
  return detail.handled;
}

/** Subscribes a thread page to node-open requests; returns the
 * unsubscribe function. `onOpen` returns true when it selected the node. */
export function listenToResearchNodeOpen(
  onOpen: (request: ResearchOpenNodeRequest) => boolean,
): () => void {
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<ResearchOpenNodeRequest & { handled?: boolean }>).detail;
    if (detail && typeof detail.treeId === "string" && typeof detail.nodeId === "string") {
      const path = Array.isArray(detail.path) ? detail.path : undefined;
      if (onOpen({ treeId: detail.treeId, nodeId: detail.nodeId, record: detail.record !== false, path })) {
        detail.handled = true;
      }
    }
  };
  window.addEventListener(OPEN_NODE_EVENT, handler);
  return () => window.removeEventListener(OPEN_NODE_EVENT, handler);
}
