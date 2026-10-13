import type { ComponentProps, Ref } from "react";
import { columnAttributes, type ResearchColumn } from "../../lib/researchColumns";
import type { ResearchNode, ResearchTreeDetail } from "../../types";
import { ResearchPairHeader } from "./ResearchColumnChrome";
import { ResearchColumnResizer } from "./ResearchColumnResizer";
import type { ResearchComposerHandle } from "./ResearchConversationComposer";
import type { PostActions } from "./ResearchPost";
import ResearchPostColumn from "./ResearchPostColumn";
import ResearchPostThread, { postThreadEntries, type ResearchPostThreadHandle } from "./ResearchPostThread";
import { researchUnitMenuProps, type ResearchUnitMenuPlacement } from "./researchUnitMenu";
import { researchNoteDoubleClickProps } from "./researchNoteDoubleClick";
import { NOTE_DOUBLE_CLICK_IGNORE_SELECTOR } from "../../lib/researchNoteEdit";

type HistoryNav = ComponentProps<typeof ResearchPairHeader>["history"];

/** A note level's note column (N{level}): the note itself. Every note, the
 * root note and each follow-up note, has a … menu in the header, which is
 * also the column's context menu. A double-click on the note, outside its
 * links, buttons and embeds, edits it (`onEdit`, absent when it cannot be
 * edited). */
export function ResearchNoteColumn({
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
  /** The note's name, for the column's accessible name. */
  title: string;
  history: HistoryNav;
  archived: boolean;
  /** The note's menu: whether it is open from its … button, and how it
   * opens from the button or as a context menu. */
  menu: {
    open: boolean;
    onOpen: (trigger: HTMLButtonElement) => void;
    onContextMenu: (placement: ResearchUnitMenuPlacement) => void;
  };
  scrollRef: Ref<HTMLDivElement> | undefined;
  onSelectNode: (nodeId: string) => void;
  onEdit?: () => void;
}) {
  const editProps = researchNoteDoubleClickProps(onEdit, NOTE_DOUBLE_CLICK_IGNORE_SELECTOR);
  const menuProps = researchUnitMenuProps(menu.onContextMenu, (scroll) => ({
    element: scroll.closest("section")?.querySelector<HTMLElement>(".research-head-menu") ?? null,
    align: "end",
  }));
  return (
    <section
      className={`research-pair-post${current ? " is-current" : ""}`}
      {...columnAttributes(column)}
      aria-label={`Note: ${title}`}
    >
      {/* The note itself starts the column, so the header names the
          column ("Note") rather than repeating the note's text. */}
      <ResearchPairHeader
        title="Note"
        history={history}
        archived={archived}
        menu={{ label: "Note actions", open: menu.open, onOpen: menu.onOpen }}
      />
      <div ref={scrollRef} className="research-column-scroll" tabIndex={-1} {...menuProps} {...editProps}>
        <div className="research-column-content research-reading-surface">
          <ResearchPostColumn detail={detail} post={post} onSelectNode={onSelectNode} />
        </div>
      </div>
      <ResearchColumnResizer kind="answer" label="Resize note column" />
    </section>
  );
}

/** A note level's follow-ups column (T{level}): the note's follow-ups, with
 * the one open as the next level marked. Each row's context menu is its
 * follow-up's menu: a follow-up note's note menu, an AI follow-up's answer
 * menu. */
export function ResearchFollowUpsColumn({
  column,
  current,
  nodes,
  post,
  archived,
  postActions,
  requireCmdEnterToSend,
  openNodeId,
  composerRef,
  threadRef,
  onOpenFollowUp,
  onOpenContextMenu,
  onEditNote,
}: {
  column: Extract<ResearchColumn, { role: "thread" }>;
  current: boolean;
  nodes: ResearchNode[];
  post: ResearchNode;
  archived: boolean;
  postActions: PostActions;
  requireCmdEnterToSend: boolean;
  /** The follow-up open as the next level. */
  openNodeId: string | null;
  composerRef: Ref<ResearchComposerHandle>;
  threadRef: Ref<ResearchPostThreadHandle>;
  onOpenFollowUp: (nodeId: string) => void;
  onOpenContextMenu: (node: ResearchNode, placement: ResearchUnitMenuPlacement) => void;
  onEditNote?: (nodeId: string, row: HTMLElement) => void;
}) {
  return (
    <section
      className={`research-pair-thread${current ? " is-current" : ""}`}
      {...columnAttributes(column)}
      aria-label="Follow-ups"
    >
      <ResearchPairHeader title="Follow-ups" count={postThreadEntries(nodes, post).length} />
      <div className="research-column-scroll">
        <div className="research-column-content research-reading-surface">
          <ResearchPostThread
            nodes={nodes}
            post={post}
            archived={archived}
            actions={postActions}
            requireCmdEnterToSend={requireCmdEnterToSend}
            openNodeId={openNodeId}
            composerRef={composerRef}
            threadRef={threadRef}
            onOpenFollowUp={onOpenFollowUp}
            onOpenContextMenu={onOpenContextMenu}
            onEditNote={onEditNote}
          />
        </div>
      </div>
      <ResearchColumnResizer kind="messages" label="Resize follow-ups column" />
    </section>
  );
}
