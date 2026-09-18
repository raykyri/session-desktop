import { useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { useWorkspaces } from "../../api/queries.js";
import { useWorkspaceScope } from "../../features/sidebar/scope.js";
import { cn } from "../../lib/cn.js";
import { useConnectionStore } from "../../stores/connection.js";
import { useNavigationStore } from "../../stores/navigation.js";
import { HistoryNav } from "../../ui/HistoryNav.js";
import { SidebarRestoreButton } from "../../ui/SidebarRestoreButton.js";

/** Displays the active workspace scope in the stage header so the current filter remains visible when the sidebar is collapsed. */
function WorkspaceScopeLabel() {
  const { workspaceId } = useWorkspaceScope();
  const workspaces = useWorkspaces();
  const current = (workspaces.data ?? []).find((workspace) => workspace.id === workspaceId);
  if (!current) return null;
  return (
    <span className="text-fg-subtle min-w-0 truncate text-xs" title={`Workspace: ${current.name}`}>
      {current.name}
    </span>
  );
}

const STATUS_LABEL = {
  connecting: "Connecting",
  open: "Connected",
  closed: "Disconnected",
} as const;

const STATUS_DOT = {
  connecting: "bg-status-active",
  open: "bg-status-success",
  closed: "bg-status-failed",
} as const;

/**
 * The bar above the routed view: the sidebar restore control when the sidebar
 * is hidden, back/forward, and the connection indicator.
 *
 * Back and forward drive browser history (ADR-7). TanStack Router does not
 * expose "can go forward", and `window.history.length` cannot distinguish
 * forward entries from entries behind the current one, so the header tracks
 * its own position in the session history and increments it when navigation
 * adds an entry.
 */
export function StageHeader() {
  const router = useRouter();
  const collapsed = useNavigationStore((state) => state.sidebarCollapsed);
  const setCollapsed = useNavigationStore((state) => state.setSidebarCollapsed);
  const status = useConnectionStore((state) => state.status);
  const [position, setPosition] = useState({ index: 0, length: 1 });

  useEffect(() => {
    const update = () => {
      const length = router.history.length;
      setPosition((current) =>
        length > current.length
          ? { index: current.index + 1, length }
          : { index: Math.min(current.index, length - 1), length },
      );
    };
    update();
    return router.history.subscribe(update);
  }, [router]);

  const canGoBack = position.index > 0;
  const canGoForward = position.index < position.length - 1;

  return (
    <header className="h-control-lg border-border-divider bg-surface-header flex shrink-0 items-center gap-2 border-b px-2">
      {collapsed ? <SidebarRestoreButton onRestore={() => setCollapsed(false)} /> : null}
      <HistoryNav
        canGoBack={canGoBack}
        canGoForward={canGoForward}
        onBack={() => {
          setPosition((current) => ({ ...current, index: Math.max(0, current.index - 1) }));
          router.history.back();
        }}
        onForward={() => {
          setPosition((current) => ({
            ...current,
            index: Math.min(current.length - 1, current.index + 1),
          }));
          router.history.forward();
        }}
      />
      <WorkspaceScopeLabel />
      <div className="flex-1" />
      <span
        className="text-fg-subtle flex items-center gap-1.5 text-xs"
        title={STATUS_LABEL[status]}
      >
        <span className={cn("size-1.5 rounded-full", STATUS_DOT[status])} aria-hidden="true" />
        <span className="sr-only">{STATUS_LABEL[status]}</span>
      </span>
    </header>
  );
}
