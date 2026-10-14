// A note level's two columns (`09-research-document-view.md` §3), ported
// from the desktop `ResearchNoteColumns.tsx`: the note column (N{level}),
// the note itself, whose … menu is also its context menu and which a
// double-click edits; and the follow-ups column (T{level}), the note's
// follow-ups with the one open as the next level marked.

import type { ModelInfo, ResearchNode, ResearchTreeDetail } from "@session/shared";
import { columnAttributes, type ResearchColumn } from "@session/shared/lib/researchColumns";
import { NOTE_DOUBLE_CLICK_IGNORE_SELECTOR } from "@session/shared/lib/researchNoteEdit";
import type { Ref } from "react";

import { cn } from "../../lib/cn.js";

import { PairHeader, type ThreadHistoryNav } from "./ColumnChrome.js";
import { ColumnResizer } from "./ColumnResizer.js";
import type { ComposerHandle } from "./ConversationComposer.js";
import { COLUMN_SCROLL } from "./MessagesColumn.js";
import type { ModelChoice } from "./ModelPicker.js";
import { PostColumnBody } from "./PostColumn.js";
import {
  PostThread,
  postThreadEntries,
  type PostActions,
  type PostThreadHandle,
} from "./PostThread.js";
import { noteDoubleClickProps } from "./noteDoubleClick.js";

export function NoteColumn({
  column,
  current,
  detail,
  post,
  title,
  history,
  archived,
  menu,
  scrollRef,
  onSelectNode,
  onEdit,
}: {
  column: Extract<ResearchColumn, { role: "post" }>;
  current: boolean;
  detail: ResearchTreeDetail;
  post: ResearchNode;
  title: string;
  history: ThreadHistoryNav | null;
  archived: boolean;
  menu: {
    open: boolean;
    onOpen: (trigger: HTMLButtonElement) => void;
    onContextMenu: (point: { x: number; y: number }) => void;
  };
  scrollRef: Ref<HTMLDivElement> | undefined;
  onSelectNode: (nodeId: string) => void;
  onEdit?: () => void;
}) {
  const editProps = noteDoubleClickProps(
    onEdit ? () => onEdit() : undefined,
    NOTE_DOUBLE_CLICK_IGNORE_SELECTOR,
  );
  return (
    <section
      className={cn(
        "research-pair-post relative flex h-full w-(--research-answer-width) min-w-0 shrink-0 flex-col",
        "border-border-strong border-r border-l border-r-[var(--surface-divider)] bg-[var(--research-thread-page-bg)]",
        current && "is-current",
      )}
      {...columnAttributes(column)}
      aria-label={`Note: ${title}`}
    >
      <PairHeader
        title="Note"
        history={history}
        archived={archived}
        current={current}
        menu={{ label: "Note actions", open: menu.open, onOpen: menu.onOpen }}
      />
      <div
        ref={scrollRef}
        className={cn(COLUMN_SCROLL, "research-reading-surface")}
        data-research-scroll=""
        tabIndex={-1}
        onContextMenu={(event) => {
          if (event.target instanceof Element && event.target.closest("a")) return;
          event.preventDefault();
          menu.onContextMenu({ x: event.clientX, y: event.clientY });
        }}
        {...editProps}
      >
        <PostColumnBody detail={detail} post={post} onSelectNode={onSelectNode} />
      </div>
      <ColumnResizer kind="answer" label="Resize note column" />
    </section>
  );
}

export function FollowUpsColumn({
  column,
  current,
  nodes,
  post,
  archived,
  postActions,
  models,
  defaultChoice,
  openNodeId,
  composerRef,
  threadRef,
  onOpenFollowUp,
  onOpenContextMenu,
  onEditNote,
}: {
  column: Extract<ResearchColumn, { role: "thread" }>;
  current: boolean;
  nodes: readonly ResearchNode[];
  post: ResearchNode;
  archived: boolean;
  postActions: PostActions;
  models: readonly ModelInfo[];
  defaultChoice: ModelChoice | null;
  openNodeId: string | null;
  composerRef: Ref<ComposerHandle>;
  threadRef: Ref<PostThreadHandle>;
  onOpenFollowUp: (nodeId: string) => void;
  onOpenContextMenu: (node: ResearchNode, point: { x: number; y: number }) => void;
  onEditNote?: (nodeId: string, row: HTMLElement) => void;
}) {
  return (
    <section
      className={cn(
        "research-pair-thread relative flex h-full w-(--research-messages-width) min-w-0 shrink-0 flex-col",
        "border-r border-r-[var(--surface-divider)] bg-[var(--research-feed-bg)]",
        current && "is-current",
      )}
      {...columnAttributes(column)}
      aria-label="Follow-ups"
    >
      <PairHeader
        title="Follow-ups"
        count={postThreadEntries(nodes, post).length}
        current={current}
      />
      <div className={COLUMN_SCROLL} data-research-scroll="">
        <div className="research-column-content research-reading-surface">
          <PostThread
            nodes={nodes}
            post={post}
            archived={archived}
            actions={postActions}
            models={models}
            defaultChoice={defaultChoice}
            openNodeId={openNodeId}
            composerRef={composerRef}
            threadRef={threadRef}
            onOpenFollowUp={onOpenFollowUp}
            onOpenContextMenu={onOpenContextMenu}
            onEditNote={onEditNote}
          />
        </div>
      </div>
      <ColumnResizer kind="messages" label="Resize follow-ups column" />
    </section>
  );
}
