// The document's own header (`09-research-document-view.md` §2).
//
// The breadcrumb down to the selected node, a chip counting what this page
// shows, the full-transcript toggle, and Cancel while a run is in flight.
// Node-level back/forward has no buttons here: it is driven by ⌘[ / ⌘] and the
// mouse back/forward buttons (`ResearchPage.tsx`).
//
// The breadcrumb collapses deep paths to "root / … / parent / current": the
// Deep hierarchies collapse intermediate breadcrumbs to prevent UI crowding.

import type { ResearchNode, ResearchTreeDetail } from "@session/shared";
import { ScrollText, X } from "lucide-react";
import { useMemo } from "react";

import { cn } from "../../lib/cn.js";
import { ControlButton, IconButton } from "../../ui/Button.js";
import { FOCUS_RING } from "../../ui/surfaces.js";

export type BreadcrumbEntry =
  { kind: "node"; node: ResearchNode; index: number } | { kind: "ellipsis"; count: number };

/** The path from the root to `selectedNodeId`, with inline follow-ups
 * collapsed into their chain head: the thread is one page, so its members share
 * one crumb. */
export function breadcrumbPath(detail: ResearchTreeDetail, selectedNodeId: string): ResearchNode[] {
  const byId = new Map(detail.nodes.map((node) => [node.id, node]));
  const path: ResearchNode[] = [];
  const seen = new Set<string>();
  let node = byId.get(selectedNodeId);
  while (node && !seen.has(node.id)) {
    seen.add(node.id);
    if (!node.inline) path.unshift(node);
    node = node.parentNodeId ? byId.get(node.parentNodeId) : undefined;
  }
  return path;
}

export function collapseBreadcrumb(path: ResearchNode[]): BreadcrumbEntry[] {
  if (path.length <= 4) {
    return path.map((node, index) => ({ kind: "node", node, index }));
  }
  const first = path[0];
  const parent = path[path.length - 2];
  const current = path[path.length - 1];
  if (!first || !parent || !current) return [];
  return [
    { kind: "node", node: first, index: 0 },
    { kind: "ellipsis", count: path.length - 3 },
    { kind: "node", node: parent, index: path.length - 2 },
    { kind: "node", node: current, index: path.length - 1 },
  ];
}

export interface DocumentHeaderProps {
  detail: ResearchTreeDetail;
  selectedNodeId: string;
  threadLength: number;
  branchCount: number;
  onSelectNode: (nodeId: string) => void;
  /** Present only when the selected segment has activity worth revealing. */
  fullTrace: { active: boolean; onToggle: () => void } | null;
  cancel: { busy: boolean; onCancel: () => void } | null;
}

export function DocumentHeader({
  detail,
  selectedNodeId,
  threadLength,
  branchCount,
  onSelectNode,
  fullTrace,
  cancel,
}: DocumentHeaderProps) {
  const crumbs = useMemo(
    () => collapseBreadcrumb(breadcrumbPath(detail, selectedNodeId)),
    [detail, selectedNodeId],
  );

  return (
    <header className="research-reading-surface border-border-divider flex shrink-0 items-center gap-2 border-b px-8 pt-[7px] pb-1.5 max-[900px]:px-7">
      <nav
        className="flex min-w-0 flex-1 items-center gap-1 text-[length:var(--research-body-font-size)]"
        aria-label="Research path"
      >
        {crumbs.map((entry, position) =>
          entry.kind === "ellipsis" ? (
            <span key="ellipsis" className="flex items-center gap-1">
              <span className="text-fg-faint" aria-hidden="true">
                /
              </span>
              <span
                className="text-fg-faint"
                title={`${entry.count} earlier ${entry.count === 1 ? "step" : "steps"}`}
              >
                …
              </span>
            </span>
          ) : (
            <span key={entry.node.id} className="flex min-w-0 items-center gap-1">
              {position > 0 ? (
                <span className="text-fg-faint" aria-hidden="true">
                  /
                </span>
              ) : null}
              <button
                type="button"
                className={cn(
                  "text-fg-secondary hover:text-fg-strong min-w-0 truncate border-0 bg-transparent p-0 text-left",
                  FOCUS_RING,
                )}
                onClick={() => onSelectNode(entry.node.id)}
              >
                {entry.index === 0 ? detail.tree.title : (entry.node.title ?? entry.node.prompt)}
              </button>
            </span>
          ),
        )}
      </nav>
      {threadLength > 1 ? (
        <span className="text-fg-subtle shrink-0 text-xs">
          {threadLength} turns in thread
          {branchCount > 0
            ? ` · ${branchCount} ${branchCount === 1 ? "branch" : "branches"} in thread`
            : ""}
        </span>
      ) : null}
      {fullTrace ? (
        <IconButton
          label={fullTrace.active ? "Hide full transcript" : "Show full transcript"}
          aria-pressed={fullTrace.active}
          className={cn(fullTrace.active && "text-fg-strong")}
          onClick={fullTrace.onToggle}
        >
          <ScrollText size={15} aria-hidden="true" />
        </IconButton>
      ) : null}
      {cancel ? (
        <ControlButton size="sm" disabled={cancel.busy} onClick={cancel.onCancel}>
          <X size={14} aria-hidden="true" />
          {cancel.busy ? "Cancelling…" : "Cancel"}
        </ControlButton>
      ) : null}
    </header>
  );
}
