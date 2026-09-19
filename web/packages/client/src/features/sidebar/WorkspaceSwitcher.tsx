// The workspace switcher (`10-home-feed-journal-encyclopedia.md` §7, ported
// from `ResearchFolderSwitcher.tsx`).
//
// The desktop's workspaces were directories, so creating one opened a native
// folder picker and the menu offered "Open in Finder" and "Move folder". On the
// web a workspace is a row, so creating one asks for a name and those two items
// are gone. What stays: the list with tree counts, rename, remove (refused
// while a run is active), reorder, and set as default.

import type { AppShortcutCommand, Workspace } from "@session/shared";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  Folder,
  FolderPlus,
  Pencil,
  Star,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";

import {
  createResearchWorkspace,
  removeResearchWorkspace,
  renameResearchWorkspace,
  reorderResearchWorkspaces,
  setDefaultResearchWorkspace,
} from "../../api/api.js";
import { queryKeys, useSettings, useTreeSummaries, useWorkspaces } from "../../api/queries.js";
import { cn } from "../../lib/cn.js";
import { pushErrorToast, pushToast } from "../../lib/toast.js";
import { Menu, MenuItem, MenuSeparator } from "../../ui/Menu.js";

import { AsyncConfirmDialog, NameDialog } from "./dialogs.js";
import { IconMenuItem } from "./menuRows.js";
import { SIDEBAR_ROW } from "./rows.js";

type WorkspaceRow = Workspace & { treeCount?: number };

/** Prevent workspace deletion while any research runs are active. */
export function workspaceRemovalRefusal(runningTrees: number): string | null {
  if (runningTrees === 0) return null;
  return runningTrees === 1
    ? "One research thread here is still running. Wait for it to finish or cancel it first."
    : `${runningTrees} research threads here are still running. Wait for them to finish or cancel them first.`;
}

export function WorkspaceSwitcher({
  workspaceId,
  onSelect,
}: {
  workspaceId: string;
  onSelect: (workspaceId: string) => void;
}) {
  const client = useQueryClient();
  const workspaces = useWorkspaces();
  const settings = useSettings();
  const scopedTrees = useTreeSummaries({ workspaceId, includeArchived: true });
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [removing, setRemoving] = useState(false);

  // Cmd-O is resolved by the shell's one chord table and re-dispatched as a
  // window event, because the layer that owns the menu is this component
  // (07 §5). Toggling rather than opening lets the same chord dismiss it.
  useEffect(() => {
    const onShortcut = (event: Event) => {
      const command = (event as CustomEvent<AppShortcutCommand>).detail;
      if (command?.type === "openFolderMenu") setOpen((current) => !current);
    };
    window.addEventListener("session:shortcut", onShortcut);
    return () => window.removeEventListener("session:shortcut", onShortcut);
  }, []);

  const list: WorkspaceRow[] = workspaces.data ?? [];
  const current = list.find((workspace) => workspace.id === workspaceId) ?? null;
  const isDefault = settings.data?.defaultWorkspaceId === workspaceId;
  const runningTrees = (scopedTrees.data ?? []).filter((tree) => tree.runningCount > 0).length;

  const refreshWorkspaces = () =>
    void client.invalidateQueries({ queryKey: queryKeys.workspaces() });

  const move = (direction: -1 | 1) => {
    if (!current) return;
    const ids = list.map((workspace) => workspace.id);
    const from = ids.indexOf(current.id);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= ids.length) return;
    const next = [...ids];
    // Both indices are inside the array, checked above.
    next[from] = ids[to] as string;
    next[to] = ids[from] as string;
    void reorderResearchWorkspaces(next)
      .then(refreshWorkspaces)
      .catch((error: unknown) => pushErrorToast("Failed to reorder workspaces", error));
  };

  return (
    <div className="relative flex items-center gap-1 px-2 pt-px">
      <Menu
        open={open}
        onOpenChange={setOpen}
        side="bottom"
        align="start"
        label="Workspaces"
        className="min-w-64"
        trigger={
          <button type="button" className={cn(SIDEBAR_ROW, "border-0 bg-transparent text-left")}>
            <Folder size={14} aria-hidden="true" className="shrink-0" />
            <span className="min-w-0 flex-1 truncate">{current ? current.name : "Workspaces"}</span>
            <ChevronDown size={14} aria-hidden="true" className="shrink-0" />
          </button>
        }
      >
        {list.map((workspace) => (
          <MenuItem
            key={workspace.id}
            onClick={() => onSelect(workspace.id)}
            hint={workspace.treeCount === undefined ? undefined : String(workspace.treeCount)}
          >
            <span className="flex min-w-0 items-center gap-2">
              <Check
                size={13}
                aria-hidden="true"
                className={cn("shrink-0", workspace.id === workspaceId ? "" : "invisible")}
              />
              <span className="truncate">{workspace.name}</span>
            </span>
          </MenuItem>
        ))}
        {list.length > 0 ? <MenuSeparator /> : null}
        <IconMenuItem
          icon={<FolderPlus size={13} aria-hidden="true" />}
          label="New workspace…"
          onClick={() => setCreating(true)}
        />
        {current ? (
          <>
            <MenuSeparator />
            <IconMenuItem
              icon={<Star size={13} aria-hidden="true" />}
              label="Make default workspace"
              disabled={isDefault}
              onClick={() => {
                void setDefaultResearchWorkspace(current.id)
                  .then(() => {
                    void client.invalidateQueries({ queryKey: queryKeys.settings() });
                    pushToast({ title: `“${current.name}” is now the default workspace` });
                  })
                  .catch((error: unknown) =>
                    pushErrorToast("Failed to set default workspace", error),
                  );
              }}
            />
            <IconMenuItem
              icon={<ArrowUp size={13} aria-hidden="true" />}
              label="Move up"
              disabled={list[0]?.id === current.id}
              onClick={() => move(-1)}
            />
            <IconMenuItem
              icon={<ArrowDown size={13} aria-hidden="true" />}
              label="Move down"
              disabled={list.at(-1)?.id === current.id}
              onClick={() => move(1)}
            />
            <IconMenuItem
              icon={<Pencil size={13} aria-hidden="true" />}
              label={`Rename “${current.name}”`}
              onClick={() => setRenaming(true)}
            />
            <IconMenuItem
              icon={<Trash2 size={13} aria-hidden="true" />}
              label={`Delete “${current.name}”`}
              tone="danger"
              onClick={() => setRemoving(true)}
            />
          </>
        ) : null}
      </Menu>

      <NameDialog
        open={creating}
        title="New workspace"
        description="Each workspace has separate research threads, folders, and encyclopedia pages."
        label="Workspace name"
        confirmLabel="Create"
        onOpenChange={setCreating}
        onSubmit={(name) => {
          void createResearchWorkspace(name)
            .then((workspace) => {
              refreshWorkspaces();
              onSelect(workspace.id);
            })
            .catch((error: unknown) => pushErrorToast("Failed to create workspace", error));
        }}
      />

      <NameDialog
        open={renaming}
        title="Rename workspace"
        label="Workspace name"
        initialValue={current?.name ?? ""}
        confirmLabel="Rename"
        onOpenChange={setRenaming}
        onSubmit={(name) => {
          if (!current || name === current.name) return;
          void renameResearchWorkspace(current.id, name)
            .then(refreshWorkspaces)
            .catch((error: unknown) => pushErrorToast("Failed to rename workspace", error));
        }}
      />

      <AsyncConfirmDialog
        open={removing}
        title={current ? `Delete “${current.name}”?` : "Delete workspace?"}
        description={
          workspaceRemovalRefusal(runningTrees) ??
          "This deletes the workspace and every research thread inside it. This can’t be undone."
        }
        confirmLabel="Delete workspace"
        pendingLabel="Deleting…"
        onOpenChange={setRemoving}
        onConfirm={async () => {
          if (!current) return;
          const refusal = workspaceRemovalRefusal(runningTrees);
          // Validate locally to avoid an unnecessary round trip when active runs prevent workspace deletion.
          if (refusal) throw new Error(refusal);
          await removeResearchWorkspace(current.id);
          refreshWorkspaces();
          const next = list.find((workspace) => workspace.id !== current.id);
          if (next) onSelect(next.id);
        }}
      />
    </div>
  );
}
