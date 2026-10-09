// Cross-component channels for research-surface shortcuts. The app-level
// shortcut dispatcher lives in App.tsx while the follow-up composer belongs to
// ResearchDocument and the folder menu's open state to ResearchFolderSwitcher,
// so window events bridge those portaled surfaces back to their owners. Each
// target component is mounted at most once (the active document, the research
// sidebar's switcher), so the events carry no addressing detail.

const FOCUS_FOLLOWUPS_EVENT = "session:research-focus-followups";
const TOGGLE_FOLDER_MENU_EVENT = "session:research-toggle-folder-menu";

/** Asks the mounted research document to bring its follow-up composer into
 * view and focus it. No-op when no document is on the research stage. */
export function requestResearchFollowupsFocus() {
  window.dispatchEvent(new CustomEvent(FOCUS_FOLLOWUPS_EVENT));
}

/** Subscribes the research document to follow-up focus requests; returns the
 * unsubscribe function. */
export function listenToResearchFollowupsFocus(onFocus: () => void): () => void {
  const handler = () => onFocus();
  window.addEventListener(FOCUS_FOLLOWUPS_EVENT, handler);
  return () => window.removeEventListener(FOCUS_FOLLOWUPS_EVENT, handler);
}

/** Asks the research sidebar's folder switcher to toggle its dropdown menu.
 * No-op outside research mode, where the switcher is unmounted. */
export function requestResearchFolderMenuToggle() {
  window.dispatchEvent(new CustomEvent(TOGGLE_FOLDER_MENU_EVENT));
}

/** Subscribes the folder switcher to menu toggle requests; returns the
 * unsubscribe function. */
export function listenToResearchFolderMenuToggle(onToggle: () => void): () => void {
  const handler = () => onToggle();
  window.addEventListener(TOGGLE_FOLDER_MENU_EVENT, handler);
  return () => window.removeEventListener(TOGGLE_FOLDER_MENU_EVENT, handler);
}

const OPEN_NODE_EVENT = "session:research-open-node";

interface ResearchOpenNodeRequest {
  treeId: string;
  nodeId: string;
}

/** Asks the mounted document for `treeId` to show `nodeId`: a branch opens in
 * the drawer, a follow-up of the conversation scrolls into view. The app shell
 * also records the node in the navigation store, which covers the case where
 * no document for that tree is mounted yet. */
export function requestResearchNodeOpen(treeId: string, nodeId: string) {
  window.dispatchEvent(
    new CustomEvent<ResearchOpenNodeRequest>(OPEN_NODE_EVENT, { detail: { treeId, nodeId } }),
  );
}

/** Subscribes a research document to node-open requests; returns the
 * unsubscribe function. */
export function listenToResearchNodeOpen(
  onOpen: (request: ResearchOpenNodeRequest) => void,
): () => void {
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<ResearchOpenNodeRequest>).detail;
    if (detail && typeof detail.treeId === "string" && typeof detail.nodeId === "string") {
      onOpen(detail);
    }
  };
  window.addEventListener(OPEN_NODE_EVENT, handler);
  return () => window.removeEventListener(OPEN_NODE_EVENT, handler);
}
