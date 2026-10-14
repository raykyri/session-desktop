// A note's follow-ups column body (`09-research-document-view.md` §3),
// ported from the desktop `ResearchPostThread.tsx`: the follow-up box at the
// top, then one row per follow-up, oldest first. A follow-up note's row shows
// its text; an AI follow-up's row also shows its answer state. A row opens its
// follow-up as the next level; a double-click on a follow-up note's row edits
// it. One row is in the tab order: the open follow-up's, else the one focused
// last, else the first.

import type { ModelInfo, ResearchImageAttachment, ResearchNode } from "@session/shared";
import { findModel, nodeModelId } from "@session/shared";
import {
  nodeAttachments,
  nodePrompt,
  nodeRun,
  nodeStatus,
  nodeType,
} from "@session/shared/lib/researchNodeTypes";
import { researchNoteEditable } from "@session/shared/lib/researchNoteEdit";
import { shortWhen } from "@session/shared/lib/shortTime";
import { LoaderCircle, Sparkles, StickyNote } from "lucide-react";
import { useId, useImperativeHandle, useMemo, useState } from "react";
import type { Ref } from "react";

import { cn } from "../../lib/cn.js";
import { FOCUS_RING } from "../../ui/surfaces.js";

import type { ComposerHandle } from "./ConversationComposer.js";
import type { ModelChoice } from "./ModelPicker.js";
import { PostFollowUpField } from "./PostFollowUpField.js";
import { MessageImages } from "./Turn.js";
import { noteDoubleClickProps } from "./noteDoubleClick.js";
import { runActive, runRetryable } from "./runState.js";

/** Makes `row` the one in the tab order without focusing it (⌃Tab with
 * focus kept in a text field). */
export interface PostThreadHandle {
  makeCurrent: (row: HTMLElement) => void;
}

/** A note's follow-ups, oldest first: its children other than documents. */
export function postThreadEntries(
  nodes: readonly ResearchNode[],
  post: ResearchNode,
): ResearchNode[] {
  return nodes
    .filter((node) => node.parentNodeId === post.id && nodeType(node) !== "document")
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
}

export interface PostActions {
  onAskFollowUp: (input: {
    parentNodeId: string;
    prompt: string;
    asNote: boolean;
    images: ResearchImageAttachment[];
    choice: ModelChoice | null;
  }) => Promise<void>;
  onRetry: (nodeId: string) => Promise<void>;
}

export function PostThread({
  nodes,
  post,
  archived,
  actions,
  models,
  defaultChoice,
  openNodeId,
  composerRef,
  threadRef,
  onOpenFollowUp,
  onOpenContextMenu,
  onEditNote,
}: {
  nodes: readonly ResearchNode[];
  post: ResearchNode;
  archived: boolean;
  actions: PostActions;
  models: readonly ModelInfo[];
  defaultChoice: ModelChoice | null;
  openNodeId: string | null;
  composerRef?: Ref<ComposerHandle>;
  threadRef?: Ref<PostThreadHandle>;
  onOpenFollowUp: (nodeId: string) => void;
  onOpenContextMenu: (node: ResearchNode, point: { x: number; y: number }) => void;
  onEditNote?: (nodeId: string, row: HTMLElement) => void;
}) {
  const [activeKey, setActiveKey] = useState<string | null>(openNodeId);
  const [markedKey, setMarkedKey] = useState<string | null>(null);
  useImperativeHandle(
    threadRef,
    () => ({
      makeCurrent: (row) => {
        const key = row.dataset["threadKey"];
        if (key) {
          setActiveKey(key);
          setMarkedKey(key);
        }
      },
    }),
    [],
  );
  const [lastOpen, setLastOpen] = useState(openNodeId);
  if (openNodeId !== lastOpen) {
    setLastOpen(openNodeId);
    if (openNodeId) setActiveKey(openNodeId);
  }
  const followUps = useMemo(() => postThreadEntries(nodes, post), [nodes, post]);
  const tabKey = followUps.some((node) => node.id === activeKey)
    ? activeKey
    : (followUps[0]?.id ?? null);
  return (
    <div className="flex flex-col">
      {!archived ? (
        <PostFollowUpField
          key={post.id}
          models={models}
          defaultChoice={defaultChoice}
          composerRef={composerRef}
          onSubmit={(input) => actions.onAskFollowUp({ parentNodeId: post.id, ...input })}
        />
      ) : null}
      {followUps.length > 0 ? (
        <ol className="m-0 list-none py-1.5" aria-label="Follow-ups">
          {followUps.map((node) => (
            <FollowUpRow
              key={node.id}
              child={node}
              archived={archived}
              open={node.id === openNodeId}
              tabbable={tabKey === node.id}
              marked={markedKey === node.id && tabKey === node.id}
              onRetry={actions.onRetry}
              onOpen={onOpenFollowUp}
              onOpenContextMenu={onOpenContextMenu}
              onEdit={
                onEditNote && researchNoteEditable(node, archived)
                  ? (row) => onEditNote(node.id, row)
                  : undefined
              }
              onFocus={() => {
                setActiveKey(node.id);
                setMarkedKey(null);
              }}
            />
          ))}
        </ol>
      ) : (
        <p className="text-fg-faint m-0 px-4 py-3 text-sm">No follow-ups yet.</p>
      )}
    </div>
  );
}

function FollowUpStatus({
  child,
  archived,
  onRetry,
}: {
  child: ResearchNode;
  archived: boolean;
  onRetry: (nodeId: string) => Promise<void>;
}) {
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (runActive(child)) {
    return (
      <div className="text-fg-muted flex items-center gap-1.5 text-xs" role="status">
        <LoaderCircle className="session-spin" size={12} aria-hidden="true" />
        Answering
      </div>
    );
  }
  if (!runRetryable(child)) return null;
  const run = nodeRun(child);
  const label =
    nodeStatus(child) === "failed" ? (run?.error ? `Failed: ${run.error}` : "Failed") : "Cancelled";
  return (
    <div className="text-status-failed relative z-[1] flex flex-wrap items-center gap-1 text-xs">
      <span>{error ?? label}</span>
      {!archived ? (
        <>
          <span aria-hidden="true">·</span>
          <button
            type="button"
            className={cn(
              "text-fg-secondary bg-transparent p-0 underline-offset-2 hover:underline",
              FOCUS_RING,
            )}
            disabled={retrying}
            onClick={() => {
              setRetrying(true);
              setError(null);
              onRetry(child.id)
                .catch((caught: unknown) =>
                  setError(caught instanceof Error ? caught.message : String(caught)),
                )
                .finally(() => setRetrying(false));
            }}
          >
            {retrying ? "Retrying…" : "Retry"}
          </button>
        </>
      ) : null}
    </div>
  );
}

function FollowUpRow({
  child,
  archived,
  open,
  tabbable,
  marked,
  onRetry,
  onOpen,
  onOpenContextMenu,
  onEdit,
  onFocus,
}: {
  child: ResearchNode;
  archived: boolean;
  open: boolean;
  tabbable: boolean;
  marked: boolean;
  onRetry: (nodeId: string) => Promise<void>;
  onOpen: (nodeId: string) => void;
  onOpenContextMenu: (node: ResearchNode, point: { x: number; y: number }) => void;
  onEdit?: (row: HTMLElement) => void;
  onFocus: () => void;
}) {
  const labelId = useId();
  const note = nodeType(child) === "post";
  const model = findModel(nodeModelId(child))?.label ?? "AI";
  return (
    <li
      className={cn(
        "group/row relative mx-2 flex gap-2 rounded-[10px] px-2 py-2 [&+&]:mt-0.5",
        "hover:bg-[color-mix(in_srgb,var(--research-card-selected-bg)_55%,transparent)]",
        open && "bg-[var(--research-card-selected-bg)]",
        marked && "shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--accent-color)_35%,transparent)]",
        "has-[>button:focus-visible]:shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--accent-color)_35%,transparent)]",
      )}
      data-type="follow-up"
      onContextMenu={(event) => {
        if (event.target instanceof Element && event.target.closest("a")) return;
        event.preventDefault();
        onOpenContextMenu(child, { x: event.clientX, y: event.clientY });
      }}
    >
      <button
        type="button"
        className="absolute inset-0 z-0 w-full cursor-pointer rounded-[inherit] border-0 bg-transparent p-0 focus:outline-none"
        data-research-thread-row=""
        data-thread-key={child.id}
        data-node-id={child.id}
        aria-current={open ? "true" : undefined}
        aria-labelledby={labelId}
        title={note ? "Open this note" : "Open this answer"}
        tabIndex={tabbable ? 0 : -1}
        onClick={(event) => {
          // The second click of a double-click that edits the note does not
          // open the follow-up again.
          if (onEdit && event.detail > 1) return;
          onOpen(child.id);
        }}
        onFocus={onFocus}
        {...noteDoubleClickProps(onEdit)}
      />
      <span
        className="text-fg-faint pointer-events-none relative z-[1] mt-[3px] shrink-0"
        aria-hidden="true"
      >
        {note ? <StickyNote size={11} /> : <Sparkles size={11} />}
      </span>
      <div className="pointer-events-none relative z-[1] flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="text-fg-faint flex items-center gap-1 text-xs">
          <span className="text-fg-secondary font-medium">You</span>
          {note ? null : <span>{`asked ${model}`}</span>}
          <span aria-hidden="true">·</span>
          <time
            dateTime={new Date(child.createdAt).toISOString()}
            title={new Date(child.createdAt).toLocaleString()}
          >
            {shortWhen(child.createdAt)}
          </time>
        </div>
        <div
          id={labelId}
          className="text-fg-primary line-clamp-6 text-[length:calc(var(--research-compact-font-size)+1px)] leading-(--research-compact-line-height) [overflow-wrap:anywhere] whitespace-pre-wrap"
        >
          {nodePrompt(child)}
        </div>
        <MessageImages attachments={nodeAttachments(child)} tabIndex={tabbable ? 0 : -1} />
        {note ? null : nodeStatus(child) === "complete" ? (
          <div className="text-fg-faint text-xs">Answered</div>
        ) : (
          <span className="pointer-events-auto">
            <FollowUpStatus child={child} archived={archived} onRetry={onRetry} />
          </span>
        )}
      </div>
    </li>
  );
}
