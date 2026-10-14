// The thread page's selection as browser history (`09-research-document-view.md`
// §4). The desktop keeps a visit history in the app shell
// (`researchHistory.ts`, `useResearchNavigationState`,
// `useResearchThreadNavigation`); on the web, browser history is the visit
// history and the selection is the `?sel=` search parameter: each column's
// selected message, root column first, comma-separated. Back and Forward are
// the browser's.
//
// The desktop's rules for when a visit is recorded carry over:
// - user navigation pushes an entry (selecting a message, opening a branch,
//   clearing a column), except that selecting what is already shown adds
//   nothing;
// - a selection the page makes itself replaces the entry: the selection it
//   restores on opening, a requested path it had to cut to what the tree
//   shows, and the selection after messages were removed;
// - `?node=` (a single message, from the feed or the Highlights view) opens
//   that message's source path and is replaced by `?sel=`.

import type { ResearchNode } from "@session/shared";
import { researchLevelPath } from "@session/shared/lib/researchBranchView";
import {
  researchRestoredSelection,
  researchSelectionPath,
} from "@session/shared/lib/researchColumns";
import { useNavigate, useRouter, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { recordSelection, savedSelection } from "./persistence.js";
import { useLatest } from "./useLatest.js";

/** The separator between the ids of `?sel=`. Node ids are UUIDs. */
const SELECTION_SEPARATOR = ",";

export function encodeSelection(path: readonly string[]): string {
  return path.join(SELECTION_SEPARATOR);
}

export function decodeSelection(value: string | undefined): string[] | null {
  if (!value) return null;
  const ids = value.split(SELECTION_SEPARATOR).filter(Boolean);
  return ids.length > 0 ? ids : null;
}

const sameIds = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((id, index) => id === right[index]);

/** A selection as each column's selected message: a single id opens its
 * source path. */
export function selectionAsPath(
  nodes: readonly ResearchNode[],
  selection: string | readonly string[],
): string[] {
  return typeof selection === "string"
    ? researchLevelPath(nodes, selection)
    : researchSelectionPath(nodes, selection);
}

// The furthest history index this tab has pushed to, so Forward knows whether
// there is an entry ahead. Kept in sessionStorage, which survives a reload of
// the tab as its history does.
const MAX_INDEX_KEY = "session.thread-history.max-index";

function readMaxIndex(): number {
  try {
    return Number(sessionStorage.getItem(MAX_INDEX_KEY) ?? "0") || 0;
  } catch {
    return 0;
  }
}

function writeMaxIndex(index: number): void {
  try {
    sessionStorage.setItem(MAX_INDEX_KEY, String(index));
  } catch {
    // Unavailable: Forward may stay enabled at the newest entry.
  }
}

/** Whether browser history has an entry behind and ahead of this one. */
function useHistoryButtons() {
  const router = useRouter();
  const read = useCallback(() => {
    const index = router.history.location.state.__TSR_index ?? 0;
    return { canGoBack: router.history.canGoBack(), canGoForward: index < readMaxIndex() };
  }, [router]);
  const [state, setState] = useState(read);
  useEffect(
    () =>
      router.history.subscribe(({ location, action }) => {
        const index = location.state.__TSR_index ?? 0;
        if (action.type === "PUSH") writeMaxIndex(index);
        else if (index > readMaxIndex()) writeMaxIndex(index);
        setState(read());
      }),
    [read, router],
  );
  return {
    ...state,
    goBack: useCallback(() => router.history.back(), [router]),
    goForward: useCallback(() => router.history.forward(), [router]),
  };
}

export interface ThreadVisit {
  /** The deepest selected message. */
  nodeId: string;
  /** Each column's selected message. */
  path: readonly string[];
}

export interface ThreadHistory {
  /** What the URL selects (null before the page has chosen a selection). */
  selection: string | readonly string[] | null;
  /** Records a visit to `target` (a path, or one message's source path):
   * `push` for user navigation, `replace` for a selection the page made
   * itself. Returns what is shown, or null when `target` names no message
   * of the tree. */
  visit: (target: string | readonly string[], mode?: "push" | "replace") => ThreadVisit | null;
  canGoBack: boolean;
  canGoForward: boolean;
  goBack: () => void;
  goForward: () => void;
}

/** The selection in the URL, the restore on opening and visit recording.
 * `nodes` is the tree's nodes; nothing is restored until it holds the root.
 * `knownNodeIds` names nodes created a moment ago that `nodes` may not hold
 * yet (a path through one is shown as given). */
export function useThreadHistory({
  treeId,
  nodes,
  rootNodeId,
}: {
  treeId: string;
  nodes: readonly ResearchNode[];
  rootNodeId: string | null;
}): ThreadHistory {
  const search = useSearch({ strict: false });
  const navigate = useNavigate();
  const buttons = useHistoryButtons();
  const nodesRef = useLatest(nodes);

  const urlPath = useMemo(() => decodeSelection(search.sel), [search.sel]);
  const urlNode = search.node ?? null;
  const selectionKey = urlPath ? encodeSelection(urlPath) : urlNode ? `node:${urlNode}` : "";
  // The selection most recently written, read by callers within one event
  // before the router has re-rendered.
  const writtenRef = useRef<string[] | null>(urlPath);

  const write = useCallback(
    (path: readonly string[], mode: "push" | "replace") => {
      writtenRef.current = [...path];
      recordSelection(treeId, path);
      void navigate({
        to: "/r/$treeId",
        params: { treeId },
        replace: mode === "replace",
        search: (previous: Record<string, unknown>) => ({
          ...previous,
          sel: encodeSelection(path),
          node: undefined,
        }),
      } as never);
    },
    [navigate, treeId],
  );

  // A path is written as given: the page computes it against nodes that can
  // include one created a moment ago (the fork patched the cache, and this
  // render's `nodes` does not hold it yet). The URL check below cuts a path
  // the tree does not show once the page renders it.
  const visit = useCallback(
    (target: string | readonly string[], mode: "push" | "replace" = "push") => {
      const path =
        typeof target === "string" ? researchLevelPath(nodesRef.current, target) : [...target];
      const nodeId = path[path.length - 1];
      if (!nodeId) return null;
      const current = writtenRef.current;
      // Selecting what is already shown records nothing.
      if (!current || !sameIds(current, path)) write(path, mode);
      return { nodeId, path };
    },
    [nodesRef, write],
  );

  // The selection the URL asks for, checked against the tree: on opening
  // with none, the saved one (else the root chain's last message) replaces
  // the entry; a requested path is cut to what the tree shows, and a message
  // opens its source path, both by replacing the entry.
  const hasRoot = Boolean(rootNodeId && nodes.some((node) => node.id === rootNodeId));
  useEffect(() => {
    if (!rootNodeId || !hasRoot) return;
    const nodesNow = nodesRef.current;
    if (urlPath) {
      const shown = researchSelectionPath(nodesNow, urlPath);
      writtenRef.current = shown.length > 0 ? shown : null;
      if (shown.length === 0) {
        visit(researchRestoredSelection(nodesNow, rootNodeId, null), "replace");
      } else if (!sameIds(shown, urlPath)) {
        write(shown, "replace");
      } else {
        recordSelection(treeId, shown);
      }
      return;
    }
    if (urlNode) {
      const restored = researchRestoredSelection(nodesNow, rootNodeId, urlNode);
      writtenRef.current = null;
      visit(restored, "replace");
      return;
    }
    writtenRef.current = null;
    visit(researchRestoredSelection(nodesNow, rootNodeId, savedSelection(treeId)), "replace");
    // `nodes` is read through the ref: the check runs when the URL changes
    // and when the tree first holds its root, not on every node update. A
    // removal is handled by the page, which replaces the selection itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasRoot, rootNodeId, selectionKey, treeId]);

  const selection: string | readonly string[] | null = urlPath ?? urlNode;
  return {
    selection,
    visit,
    canGoBack: buttons.canGoBack,
    canGoForward: buttons.canGoForward,
    goBack: buttons.goBack,
    goForward: buttons.goForward,
  };
}
