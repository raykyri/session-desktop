// The thread page's dialogs (`09-research-document-view.md` §8), ported
// from the desktop `ResearchThreadDialogs.tsx` and `ResearchDeleteDialog.tsx`:
// Rerun, Rename, and Delete. Deleting the root moves the research to the
// Trash, with "Delete now" as the permanent step; a message inside a thread
// is deleted at once with what follows it (messages have no Trash). All are
// centred confirm dialogs.

import type { ResearchNode } from "@session/shared";
import {
  RESEARCH_RERUN_PENDING_REASON,
  researchRerunBlocker,
} from "@session/shared/lib/researchChains";
import { nodePrompt, nodeStatus, nodeType } from "@session/shared/lib/researchNodeTypes";
import { researchDeleteLabel } from "@session/shared/lib/researchThreadView";
import { researchTrashTreeSentence } from "@session/shared/lib/researchTrash";
import { useMemo, useRef, useState } from "react";

import { cn } from "../../lib/cn.js";
import { ControlButton } from "../../ui/Button.js";
import { DeleteDialog as SharedDeleteDialog } from "../../ui/DeleteDialog.js";
import { ConfirmDialog, ConfirmDialogActionButton, Dialog } from "../../ui/Dialog.js";
import { INPUT_FIELD } from "../../ui/surfaces.js";
import { sharedTreeDeleteSteps } from "../home/TreeMenu.js";

import { branchInfo } from "./ThreadMenu.js";

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function RerunDialog({
  node,
  parent,
  pending,
  onConfirm,
  onClose,
}: {
  node: ResearchNode;
  parent: ResearchNode | null;
  pending: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const blocker = nodeStatus(node) === "complete" ? researchRerunBlocker(node, parent) : null;
  const reason = blocker ?? (pending ? RESEARCH_RERUN_PENDING_REASON : null);
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Rerun"
      description={
        <>
          Rerun will replace the current answer. Continue?
          {reason ? (
            <span className="mt-2 block" role="status">
              {reason}
            </span>
          ) : null}
        </>
      }
      confirmLabel="Continue"
      confirmDisabled={reason !== null}
      onConfirm={onConfirm}
    />
  );
}

export function RenameDialog({
  initialValue,
  isRoot,
  onRename,
  onClose,
}: {
  initialValue: string;
  isRoot: boolean;
  /** Saves the title; a rejection keeps the dialog open with its message. */
  onRename: (title: string) => Promise<void>;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const [renaming, setRenaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const confirm = () => {
    const title = value.trim();
    if (renaming || !title) return;
    setRenaming(true);
    onRename(title)
      .then(onClose)
      .catch((caught: unknown) => setError(errorText(caught)))
      .finally(() => setRenaming(false));
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !renaming) onClose();
      }}
      title={isRoot ? "Rename research" : "Rename branch"}
      initialFocus={inputRef}
      footer={
        <>
          <ControlButton disabled={renaming} onClick={onClose}>
            Cancel
          </ControlButton>
          <ConfirmDialogActionButton
            pending={renaming}
            pendingLabel="Renaming…"
            disabled={!value.trim()}
            onClick={confirm}
          >
            Rename
          </ConfirmDialogActionButton>
        </>
      }
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          confirm();
        }}
      >
        <input
          ref={inputRef}
          className={cn(INPUT_FIELD, "w-full")}
          aria-label="Title"
          value={value}
          onChange={(event) => setValue(event.currentTarget.value)}
        />
      </form>
      {error ? (
        <p className="text-status-failed mt-2 mb-0 text-sm" role="alert">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}

/** The delete confirmation of a message and what follows it, or of the
 * research (the root), on the shared two-step `ui/DeleteDialog`. Renders
 * nothing once the message is gone. */
export function DeleteDialog({
  nodes,
  nodeId,
  rootNodeId,
  treeTitle,
  groupChildCount = 0,
  shared = false,
  onTrashRoot,
  onRemove,
  onClose,
}: {
  /** The thread is shared with the reader (web only): deleting the root
   * moves it to the reader's Trash or leaves it, with Home's sentences. */
  shared?: boolean;
  nodes: ResearchNode[];
  nodeId: string;
  rootNodeId: string;
  treeTitle: string;
  /** For the root: the threads listed under it on Home, which move to the
   * Trash or are deleted with it. */
  groupChildCount?: number;
  /** Moves the research to the Trash. */
  onTrashRoot: () => Promise<void>;
  /** Deletes the message (or the research) permanently. */
  onRemove: (node: ResearchNode) => Promise<void>;
  onClose: () => void;
}) {
  const node = useMemo(
    () => nodes.find((candidate) => candidate.id === nodeId) ?? null,
    [nodeId, nodes],
  );
  const info = useMemo(() => branchInfo(nodes, nodeId), [nodeId, nodes]);
  if (!node || !info) return null;
  const name = (node.title ?? nodePrompt(node)) || treeTitle;
  const count = info.descendantCount;
  const plural = (noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
  const disabledReason = info.hasActiveRuns
    ? "It has active runs, which must finish or be cancelled before it can be deleted."
    : null;
  if (nodeId === rootNodeId && shared) {
    return (
      <SharedDeleteDialog
        {...sharedTreeDeleteSteps(name, onTrashRoot, () => onRemove(node))}
        disabledReason={null}
        onClose={onClose}
      />
    );
  }
  if (nodeId === rootNodeId) {
    const children = `${groupChildCount} ${groupChildCount === 1 ? "child" : "children"}`;
    return (
      <SharedDeleteDialog
        trash={{
          title:
            groupChildCount > 0 ? `Delete “${name}” and its ${children}?` : `Delete “${name}”?`,
          body: <p className="m-0">{researchTrashTreeSentence(count, groupChildCount)}</p>,
          onConfirm: onTrashRoot,
        }}
        remove={{
          ...(groupChildCount > 0
            ? {
                body: (
                  <p className="m-0">
                    “{name}” and its {children} will be deleted. This can’t be undone.
                  </p>
                ),
              }
            : {}),
          onConfirm: () => onRemove(node),
        }}
        disabledReason={disabledReason}
        onClose={onClose}
      />
    );
  }
  const note = nodeType(node) === "post";
  const title = note
    ? "Delete this note?"
    : node.inline && count > 0
      ? "Delete the rest of this thread?"
      : count > 0
        ? "Delete this research branch?"
        : "Delete this follow-up?";
  const what = note
    ? count > 0
      ? `This deletes the note and ${plural("follow-up")} under it.`
      : "This deletes the note."
    : node.inline && count > 0
      ? `This deletes this follow-up and everything after it in the thread, ${plural("message")} in all, including any branches. A new follow-up can then be asked from the answer before it.`
      : count > 0
        ? `This also deletes ${plural("follow-up")} under it.`
        : "This deletes the follow-up and its response.";
  return (
    <SharedDeleteDialog
      remove={{
        title,
        body: (
          <>
            <p className="m-0">“{name}”</p>
            <p className="m-0">{what} This can’t be undone.</p>
          </>
        ),
        label: note ? "Delete note" : researchDeleteLabel(false, node.inline, count),
        onConfirm: () => onRemove(node),
      }}
      disabledReason={disabledReason}
      onClose={onClose}
    />
  );
}
