// The card of a selected branch (02 §4.2; the mock's `preview`,
// `branchActs`, `branchReplies`): who asked and when, with "…" (Open as its
// own thread, Delete branch); the look-up phrase or the quoted passage; the
// run's status; the answer; Comment, Continue and Branch; the open composer;
// the comments.

import type { CommentRec, NodeRec } from "@session/mutators";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { cn } from "../../lib/cn.js";
import type { ChannelView } from "../../replica/queries.js";
import type { DraftRef } from "../../replica/source.js";
import { useWrites } from "../../replica/writes.js";
import {
  composerKey,
  useThreadUi,
  useThreadUiStore,
  type InlineComposer as Composer,
} from "../../stores/threadUi.js";
import { Avatar } from "../../ui/Avatar.js";
import { InlineComposer, focusSoon, selectedRowOr } from "../composer/InlineComposer.js";
import { AnswerProse } from "../feed/AnswerProse.js";
import { useFeedViewer, useRunChoice } from "../feed/FeedContext.js";
import { ConfirmDelete } from "../feed/FeedDialog.js";
import { ModerationNote } from "../feed/Moderated.js";
import { MoreMenu, type MoreAction } from "../feed/MoreMenu.js";
import { clip, noun, relTime } from "../feed/format.js";
import { BranchIcon, BubbleIcon, ContinueIcon, SearchIcon } from "../feed/icons.js";
import { revealThread } from "../feed/reveal.js";
import { ReplyText } from "../replies/ReplyText.js";

import { RunNote, RunProgress, isStoppedRun } from "./RunStatus.js";
import { isActiveRun, othersUnder, type TreeIndex } from "./tree.js";

/** The card fades in only when the item it shows changes (`pvFade`): keyed
 * on (thread, item) here, not on re-renders. */
const shown = new Map<string, string>();
export function useFadeIn(thread: string, item: string): boolean {
  const [fresh] = useState(() => shown.get(thread) !== item);
  useEffect(() => {
    shown.set(thread, item);
  }, [thread, item]);
  return fresh;
}

export function BranchCard({
  thread,
  node,
  index,
  channel,
  now,
  onSelect,
}: {
  thread: string;
  node: NodeRec;
  index: TreeIndex;
  channel: ChannelView | null;
  now: number;
  onSelect: (id: string | null) => void;
}) {
  const { writer, me } = useFeedViewer();
  const ui = useThreadUi(thread);
  const open = useThreadUiStore((state) => state.open);
  const close = useThreadUiStore((state) => state.close);
  const writes = useWrites();
  const choice = useRunChoice();
  const navigate = useNavigate();
  const fade = useFadeIn(thread, `b:${node.id}`);
  const [deleting, setDeleting] = useState(false);

  const run = index.run(node.id);
  const pending = isActiveRun(run);
  const answer = index.answerOf(node.id);
  const promoted = node.promoted;
  const mine = me !== null && node.u === me;

  const actions: MoreAction[] = [];
  if (writer && !pending && !promoted)
    actions.push({
      label: "Open as its own thread",
      onSelect: () =>
        void writes.promote(thread, node.id).then((id) => {
          if (id) revealThread(id);
        }),
    });
  if (writer && mine) {
    const reason = pending
      ? "Available when the answer finishes"
      : promoted
        ? "Not available after it was opened as a thread"
        : othersUnder(index, node.id, me)
          ? "Not available once someone else has responded"
          : undefined;
    actions.push({
      label: "Delete branch",
      danger: true,
      disabledReason: reason,
      onSelect: () => setDeleting(true),
    });
  }

  const composer = ui.composer;
  const askHere = writer && composer?.kind === "ask" && ui.selected === node.id ? composer : null;
  const commentTop =
    writer && composer?.kind === "comment" && composer.node === node.id && composer.parent === null;

  const openAsk = (parent: string) => {
    open(thread, { kind: "ask", parent }, node.id);
  };
  const toggleComment = (parent: string | null) => {
    const current = ui.composer;
    const isOpen =
      current?.kind === "comment" && current.node === node.id && current.parent === parent;
    if (isOpen) close(thread);
    else open(thread, { kind: "comment", node: node.id, parent });
  };

  const submitAsk = async (c: Composer & { kind: "ask" }, text: string, draft: DraftRef) => {
    // Branch on a top-level branch asks at the answer, on the same passage.
    const b = c.parent === "r" && node.b !== null ? node.b : undefined;
    const id = await writes.fork({
      draft,
      thread,
      parent: c.parent,
      q: text,
      ...(b !== undefined ? { b } : {}),
      model: choice.model,
      effort: choice.effort,
    });
    if (id) onSelect(id);
    return id !== null;
  };

  return (
    <div className={cn("preview", fade && "fadein")}>
      <div className="who">
        <Avatar handle={node.u} size="xs" />
        <b>{node.u}</b>
        <time dateTime={node.createdAt}>{relTime(node.createdAt, now)}</time>
        <span className="ml-auto inline-flex self-center">
          <MoreMenu actions={actions} />
        </span>
      </div>
      {node.look !== null ? (
        <div className="lookh">
          <SearchIcon />
          <span>Look up</span>
          <b>{node.look}</b>
        </div>
      ) : node.quote ? (
        <blockquote className="bq">{clip(node.quote, 180)}</blockquote>
      ) : null}
      {node.del ? <p className="modln">[deleted]</p> : <ModerationNote mod={node.mod} />}
      {pending || (isStoppedRun(run) && !answer) ? (
        <RunProgress
          thread={thread}
          node={node.id}
          run={run}
          pending={
            node.look !== null
              ? "Looking up the phrase."
              : "Searching sources. The answer appears here when the run finishes."
          }
        />
      ) : answer?.md ? (
        <>
          <AnswerProse md={answer.md} pages={answer.pages} />
          <RunNote run={run} />
        </>
      ) : null}
      <div className="pf">
        {writer && !pending ? (
          <button
            type="button"
            className={cn("tlink bact", commentTop && "on")}
            aria-pressed={commentTop}
            title="Comment on this branch. Does not run an answer."
            onClick={() => toggleComment(null)}
          >
            <BubbleIcon />
            Comment
          </button>
        ) : null}
        {promoted ? (
          <button
            type="button"
            className="tlink"
            onClick={() =>
              void navigate({
                to: channel ? "/c/$name" : "/",
                params: channel ? { name: channel.name } : {},
                search: { t: promoted },
              } as never)
            }
          >
            Open thread
          </button>
        ) : null}
        <span className="grow" />
        {writer && !pending ? (
          <>
            <button
              type="button"
              className="tlink bact"
              title="Ask a new question under this answer. Runs an answer."
              onClick={() => openAsk(node.id)}
            >
              <ContinueIcon />
              Continue
            </button>
            <button
              type="button"
              className="tlink bact"
              title="Ask a different question at the same point, next to this one. Runs an answer."
              onClick={() => openAsk(node.par)}
            >
              <BranchIcon />
              Branch
            </button>
          </>
        ) : null}
      </div>
      {askHere ? (
        <InlineComposer
          key={composerKey(thread, askHere)}
          draftKey={composerKey(thread, askHere)}
          placeholder={askHere.parent === node.id ? "Continue ask" : "Ask beside this"}
          submitLabel="Ask"
          onSubmit={(text, draft) => submitAsk(askHere, text, draft)}
          onClose={() => close(thread)}
          returnFocus={selectedRowOr(thread, `#card-${thread} .rcount`)}
        />
      ) : commentTop ? (
        <InlineComposer
          key={`c:${node.id}`}
          draftKey={composerKey(thread, { kind: "comment", node: node.id, parent: null })}
          placeholder="Comment here"
          submitLabel="Comment"
          onSubmit={async (text, draft) => {
            const ok = (await writes.comment(thread, node.id, text, undefined, draft)) !== null;
            if (ok) close(thread);
            return ok;
          }}
          onClose={() => close(thread)}
          returnFocus={selectedRowOr(thread, `#card-${thread} .rcount`)}
        />
      ) : null}
      <BranchComments
        thread={thread}
        node={node.id}
        comments={index.comments(node.id)}
        pending={pending}
        now={now}
        channel={channel}
        onToggle={toggleComment}
        openParent={
          writer && composer?.kind === "comment" && composer.node === node.id
            ? composer.parent
            : undefined
        }
      />
      <ConfirmDelete
        open={deleting}
        onOpenChange={setDeleting}
        title="Delete this branch and the branches under it?"
        onConfirm={() => {
          // Focus goes to the next row of the tree, once this one is gone.
          const next = nextRowAfter(
            thread,
            index.dfs(node.id).map((x) => x.node.id),
          );
          void writes.deleteNode(thread, node.id).then((ok) => {
            if (!ok) return;
            onSelect(null);
            focusSoon(next);
          });
        }}
      />
    </div>
  );
}

/** Comments under a branch (01 C4): "N comments", each with a Reply toggle
 * that opens a composer under it; one level of nesting (14 px). */
function BranchComments({
  thread,
  node,
  comments,
  pending,
  now,
  channel,
  onToggle,
  openParent,
}: {
  thread: string;
  node: string;
  comments: CommentRec[];
  pending: boolean;
  now: number;
  channel: ChannelView | null;
  onToggle: (parent: string | null) => void;
  /** The comment whose reply composer is open; null for the top one. */
  openParent: string | null | undefined;
}) {
  const { writer } = useFeedViewer();
  const writes = useWrites();
  const close = useThreadUiStore((state) => state.close);
  if (pending || comments.length === 0) return null;
  const tops = comments.filter((c) => c.parent === null);
  const rows: { c: CommentRec; depth: number }[] = [];
  for (const top of tops) {
    rows.push({ c: top, depth: 0 });
    for (const kid of comments.filter((x) => x.parent === top.id)) rows.push({ c: kid, depth: 1 });
  }
  return (
    <div className="brp">
      <div className="brp-h">{noun(rows.length, "comment", "comments")}</div>
      {rows.map(({ c, depth }) => {
        const parent = c.parent ?? c.id;
        const replying = openParent === c.id;
        return (
          <div key={c.id} className="brr" style={{ marginLeft: Math.min(depth, 3) * 14 }}>
            <div className="who">
              <Avatar handle={c.u} size="xs" />
              <b>{c.u}</b>
              <time dateTime={c.createdAt}>{relTime(c.createdAt, now)}</time>
            </div>
            {c.del ? (
              <p className="modln">[deleted]</p>
            ) : (
              <>
                <ModerationNote mod={c.mod} />
                {c.t ? <ReplyText text={c.t} channel={channel} /> : null}
              </>
            )}
            <div className="pf">
              {writer ? (
                <button
                  type="button"
                  className="tlink"
                  aria-pressed={replying}
                  onClick={() => onToggle(c.id)}
                >
                  {replying ? "Close reply" : "Reply"}
                </button>
              ) : null}
            </div>
            {replying ? (
              <InlineComposer
                draftKey={composerKey(thread, { kind: "comment", node, parent: c.id })}
                placeholder="Reply"
                submitLabel="Reply"
                onSubmit={async (text, draft) => {
                  const ok = (await writes.comment(thread, node, text, parent, draft)) !== null;
                  if (ok) close(thread);
                  return ok;
                }}
                onClose={() => close(thread)}
                returnFocus={selectedRowOr(thread, `#card-${thread} .rcount`)}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** The row after `gone` (a deleted row and its subtree) in its tree, else the
 * row before it, else the thread's follow-up button. */
export function nextRowAfter(thread: string, gone: readonly string[]): () => HTMLElement | null {
  const side = document.querySelector(`[data-side="${thread}"]`);
  const first = side?.querySelector<HTMLElement>(`[data-row="${gone[0] ?? ""}"]`);
  const rows = Array.from(
    first?.closest('[role="tree"]')?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [],
  );
  const at = first ? rows.indexOf(first) : -1;
  const after = rows.slice(at + 1).find((r) => !gone.includes(r.dataset["row"] ?? ""));
  const before = at > 0 ? rows[at - 1] : undefined;
  const id = (after ?? before)?.dataset["row"];
  return () =>
    (id
      ? document.querySelector<HTMLElement>(`[data-side="${thread}"] [data-row="${id}"]`)
      : null) ?? document.querySelector<HTMLElement>(`#card-${thread} .rcount`);
}
