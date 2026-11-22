// A post's replies (02 §4.3; the mock's `replyLines`): a sticky side column
// with a tree on the rail, one row per reply led by its author's avatar,
// "+N" on a collapsed reply; the selected reply's card with "…" (Delete
// reply), its text and a Reply toggle; "Reply at root" under the tree.

import type { ReplyRec, ThreadRec } from "@session/mutators";
import { useState } from "react";

import { cn } from "../../lib/cn.js";
import type { ChannelView } from "../../replica/queries.js";
import { useWrites } from "../../replica/writes.js";
import { composerKey, useThreadUi, useThreadUiStore } from "../../stores/threadUi.js";
import { Avatar } from "../../ui/Avatar.js";
import { useFadeIn, nextRowAfter } from "../branches/BranchCard.js";
import { TreeRail, type TreeRow } from "../branches/TreeRail.js";
import { InlineComposer, focusSoon, selectedRowOr } from "../composer/InlineComposer.js";
import { useFeedViewer } from "../feed/FeedContext.js";
import { ConfirmDelete } from "../feed/FeedDialog.js";
import { ModerationNote, rowText } from "../feed/Moderated.js";
import { MoreMenu } from "../feed/MoreMenu.js";
import { authorName, plainReply, relTime } from "../feed/format.js";
import { NotSentLine } from "../shell/NotSent.js";

import { ReplyText } from "./ReplyText.js";

export interface ReplyRow {
  reply: ReplyRec;
  depth: number;
  /** Replies hidden under a collapsed row. */
  hidden: number;
}

/** Rows in reading order (`flatReplies`): top-level replies, each followed
 * by its replies unless it is collapsed. */
export function replyRows(replies: readonly ReplyRec[], collapsed: readonly string[]): ReplyRow[] {
  const out: ReplyRow[] = [];
  for (const top of replies.filter((r) => r.parent === null)) {
    const kids = replies.filter((r) => r.parent === top.id);
    const shut = collapsed.includes(top.id) && kids.length > 0;
    out.push({ reply: top, depth: 0, hidden: shut ? kids.length : 0 });
    if (!shut) for (const kid of kids) out.push({ reply: kid, depth: 1, hidden: 0 });
  }
  return out;
}

export function ReplyTree({
  thread,
  replies,
  channel,
  now,
}: {
  thread: ThreadRec;
  replies: readonly ReplyRec[];
  channel: ChannelView | null;
  now: number;
}) {
  const { writer, signedOut, signIn } = useFeedViewer();
  const ui = useThreadUi(thread.id);
  const toggleCollapsed = useThreadUiStore((state) => state.toggleCollapsed);
  const toggle = useThreadUiStore((state) => state.toggle);
  const select = useThreadUiStore((state) => state.select);
  const open = useThreadUiStore((state) => state.open);
  const close = useThreadUiStore((state) => state.close);
  const writes = useWrites();
  const author = thread.u;
  const rows = replyRows(replies, ui.collapsed);
  // Only a writer has composers (a sign-out leaves none behind).
  const composer = writer && ui.composer?.kind === "reply" ? ui.composer : null;

  const replyBox = (parent: string | null, to: string | null) =>
    composer && composer.parent === parent ? (
      <InlineComposer
        key={`r:${parent ?? "top"}`}
        draftKey={composerKey(thread.id, { kind: "reply", parent })}
        placeholder={to === null ? "Reply" : `Reply to @${to}`}
        submitLabel="Reply"
        onSubmit={async (text, draft) => {
          const top =
            parent === null ? undefined : (replies.find((r) => r.id === parent)?.parent ?? parent);
          const id = await writes.reply(thread.id, text, top, draft);
          if (id) select(thread.id, id);
          return id !== null;
        }}
        onClose={() => close(thread.id)}
        returnFocus={selectedRowOr(thread.id, `[data-side="${thread.id}"] .rfoot button`)}
      />
    ) : null;

  if (rows.length === 0)
    return composer?.parent === null ? <div className="grp">{replyBox(null, author)}</div> : null;

  const selectedRow = rows.find((r) => r.reply.id === ui.selected);
  const path = new Set<string>();
  if (selectedRow) {
    path.add(selectedRow.reply.id);
    if (selectedRow.reply.parent) path.add(selectedRow.reply.parent);
  }
  const treeRows: TreeRow[] = rows.map(({ reply, depth, hidden }) => {
    const parent = depth === 0 && replies.some((r) => r.parent === reply.id);
    return {
      id: reply.id,
      parent: depth === 0 ? null : reply.parent,
      depth,
      on: path.has(reply.id),
      selected: reply.id === ui.selected,
      ...(parent ? { expanded: !ui.collapsed.includes(reply.id) } : {}),
      content: (
        <span className="gq gq-av">
          <span className="rav" title={authorName(reply.u)}>
            <Avatar handle={reply.u} size="xs" />
          </span>
          <span className="sr-only">{authorName(reply.u)}: </span>
          <span className="gt">{rowText(reply, plainReply(reply.t))}</span>
          {hidden ? (
            <span className="rhid" aria-hidden="true">
              +{hidden}
            </span>
          ) : null}
        </span>
      ),
      trailing: hidden ? (
        <button
          type="button"
          className="rhid-btn"
          tabIndex={-1}
          aria-label={`Show ${hidden} more ${hidden === 1 ? "reply" : "replies"}`}
          onClick={(event) => {
            // The button goes with the expansion; focus stays on the
            // reply's row, as it does when Right expands it.
            const tree = event.currentTarget.closest('[role="tree"]');
            toggleCollapsed(thread.id, reply.id);
            focusSoon(() =>
              tree?.querySelector<HTMLElement>(`[data-row="${CSS.escape(reply.id)}"]`),
            );
          }}
        />
      ) : undefined,
    };
  });

  const toggleTop = () => {
    if (composer?.parent === null) close(thread.id);
    else open(thread.id, { kind: "reply", parent: null });
  };

  return (
    <div className="grp">
      <TreeRail
        rows={treeRows}
        label="Replies"
        onSelect={(id) => toggle(thread.id, id)}
        onExpand={(id) => toggleCollapsed(thread.id, id)}
        layoutKey={`${ui.selected ?? ""}:${ui.collapsed.join()}`}
        lineSelector=".gq-av"
      />
      {selectedRow ? (
        <ReplyCard
          key={selectedRow.reply.id}
          thread={thread.id}
          reply={selectedRow.reply}
          replies={replies}
          channel={channel}
          now={now}
          replying={composer?.parent === selectedRow.reply.id}
          onToggleReply={() =>
            composer?.parent === selectedRow.reply.id
              ? close(thread.id)
              : open(thread.id, { kind: "reply", parent: selectedRow.reply.id })
          }
          composer={replyBox(selectedRow.reply.id, selectedRow.reply.u)}
        />
      ) : null}
      <div className="rfoot">
        {writer ? (
          <button type="button" className="tlink" onClick={toggleTop}>
            {composer?.parent === null ? "Close reply" : "Reply at root"}
          </button>
        ) : signedOut ? (
          <button type="button" className="tlink" onClick={signIn}>
            Sign in to reply
          </button>
        ) : (
          <span className="rnote">Replying opens once you have an invite</span>
        )}
      </div>
      {replyBox(null, author)}
    </div>
  );
}

function ReplyCard({
  thread,
  reply,
  replies,
  channel,
  now,
  replying,
  onToggleReply,
  composer,
}: {
  thread: string;
  reply: ReplyRec;
  replies: readonly ReplyRec[];
  channel: ChannelView | null;
  now: number;
  replying: boolean;
  onToggleReply: () => void;
  composer: React.ReactNode;
}) {
  const { writer, active, me } = useFeedViewer();
  const writes = useWrites();
  const select = useThreadUiStore((state) => state.select);
  const fade = useFadeIn(thread, `r:${reply.id}`);
  const [deleting, setDeleting] = useState(false);
  const mine = me !== null && reply.u === me;
  const othersUnder = replies.some((r) => r.parent === reply.id && r.u !== me);
  return (
    <div className={cn("preview", fade && "fadein")}>
      <div className="who">
        <Avatar handle={reply.u} size="xs" />
        <b>{authorName(reply.u)}</b>
        <time dateTime={reply.createdAt}>{relTime(reply.createdAt, now)}</time>
        {mine && active ? (
          <span className="ml-auto inline-flex self-center">
            <MoreMenu
              actions={[
                {
                  label: "Delete reply",
                  danger: true,
                  disabledReason: othersUnder
                    ? "Not available once someone else has responded"
                    : undefined,
                  onSelect: () => setDeleting(true),
                },
              ]}
            />
          </span>
        ) : null}
      </div>
      {reply.del ? (
        <p className="modln">[deleted]</p>
      ) : (
        <>
          <ModerationNote mod={reply.mod} />
          {reply.t ? <ReplyText text={reply.t} channel={channel} /> : null}
        </>
      )}
      <div className="pf">
        {writer ? (
          <button type="button" className="tlink" aria-pressed={replying} onClick={onToggleReply}>
            {replying ? "Close reply" : "Reply"}
          </button>
        ) : null}
      </div>
      <NotSentLine item={reply.id} />
      {composer}
      <ConfirmDelete
        open={deleting}
        onOpenChange={setDeleting}
        title="Delete this reply and your replies under it?"
        onConfirm={() => {
          const gone = [reply.id, ...replies.filter((r) => r.parent === reply.id).map((r) => r.id)];
          const next = nextRowAfter(thread, gone);
          void writes.deleteReply(reply.id).then((ok) => {
            if (!ok) return;
            select(thread, null);
            focusSoon(next);
          });
        }}
      />
    </div>
  );
}
