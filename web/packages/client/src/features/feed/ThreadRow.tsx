// One feed row (02 §3.1, §3.2): the thread's card, and beside it its side
// column, the branch trees of an ask or the reply tree of a post.
//
// The card (`card`): "Branched from …" on a thread opened from a branch; the
// title drawn as a tree row (hollow node, the question as typed or the
// post's text, the post's channel, the author's avatar with "handle · 3h",
// the "…" menu); an ask's answer; the footer: the ask's meta ("N sources ·
// Nk tokens · #channel"), the follow-up or Reply button with its count, Save
// with its count. A removed thread is its placeholder; a hidden one shows
// its text to its author and the owner under "Hidden by the channel owner".

import { useNavigate } from "@tanstack/react-router";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

import { cn } from "../../lib/cn.js";
import { useReplicaQuery } from "../../replica/ReplicaProvider.js";
import { askTreeOf, repliesOf, threadOf, type ThreadView } from "../../replica/queries.js";
import { UNKNOWN } from "../../replica/source.js";
import { useWrites } from "../../replica/writes.js";
import { useThreadUi, useThreadUiStore } from "../../stores/threadUi.js";
import { Avatar } from "../../ui/Avatar.js";
import { AskSide } from "../branches/AskSide.js";
import { RunStatus } from "../branches/RunStatus.js";
import { SelectionActions } from "../branches/SelectionActions.js";
import { indexTree, isActiveRun, othersUnder, passageTrees } from "../branches/tree.js";
import { RemoveDialog } from "../channels/RemoveDialog.js";
import { ReplyTree } from "../replies/ReplyTree.js";
import { FeedRow } from "../shell/Frames.js";
import { showToast } from "../shell/Toast.js";

import { AnswerProse, type PassageGroup } from "./AnswerProse.js";
import { useFeedViewer, useRunChoice } from "./FeedContext.js";
import { ConfirmDelete } from "./FeedDialog.js";
import { MoreMenu, type MoreAction } from "./MoreMenu.js";
import { clip, footerMeta, noun, relTime, showsSaveCount } from "./format.js";
import { RemovedIcon, ReplyArrowIcon, SaveIcon } from "./icons.js";

export function ThreadRow({ id, now }: { id: string; now: number }) {
  const view = useReplicaQuery((source) => threadOf(source, id), [id]);
  if (view === UNKNOWN || view === null) return null;
  const { thread } = view;
  if (thread.mod === "removed")
    return (
      <FeedRow rowId={id}>
        <RemovedCard view={view} />
      </FeedRow>
    );
  return thread.k === "post" ? <PostRow view={view} now={now} /> : <AskRow view={view} now={now} />;
}

/** The placeholder of a removed thread (01 C12, 04 §6.2): who removed it,
 * the reason, and "Ask by [deleted] in #name" for every reader. */
function RemovedCard({ view }: { view: ThreadView }) {
  const { thread, space } = view;
  const { me } = useFeedViewer();
  const writes = useWrites();
  const [deleting, setDeleting] = useState(false);
  const mine = me !== null && thread.u === me;
  return (
    <article className="tcard removed" id={`card-${thread.id}`} data-thread={thread.id}>
      <div className="rmnote">
        <RemovedIcon />
        <span className="flex-1">
          Removed by @{thread.modBy ?? "owner"}
          {thread.modNote ? <small>Reason: “{thread.modNote}”</small> : null}
          <small>
            {thread.k === "post" ? "Post" : "Ask"} by [deleted] in #{space?.name ?? ""}
          </small>
        </span>
        {mine ? (
          <MoreMenu
            actions={[
              {
                label: thread.k === "post" ? "Delete post" : "Delete ask",
                danger: true,
                onSelect: () => setDeleting(true),
              },
            ]}
          />
        ) : null}
      </div>
      <ConfirmDelete
        open={deleting}
        onOpenChange={setDeleting}
        title="Delete this thread?"
        onConfirm={() => void writes.deleteThread(thread.id)}
      />
    </article>
  );
}

function PostRow({ view, now }: { view: ThreadView; now: number }) {
  const replies = useReplicaQuery((source) => repliesOf(source, view.thread.id), [view.thread.id]);
  const list = replies === UNKNOWN ? [] : replies;
  return (
    <FeedRow
      rowId={view.thread.id}
      side={
        <div className="stick replies">
          <ReplyTree thread={view.thread} replies={list} channel={view.space} now={now} />
        </div>
      }
    >
      <ThreadCard view={view} now={now} replyOthers={list.some((r) => r.u !== view.thread.u)} />
    </FeedRow>
  );
}

function AskRow({ view, now }: { view: ThreadView; now: number }) {
  const { thread } = view;
  const tree = useReplicaQuery((source) => askTreeOf(source, thread.id), [thread.id]);
  const proseRef = useRef<HTMLDivElement>(null);
  const [passages, setPassages] = useState(0);
  const [hovered, setHovered] = useState<number | null>(null);
  const ui = useThreadUi(thread.id);
  const select = useThreadUiStore((state) => state.select);
  const index = useMemo(() => (tree === UNKNOWN ? null : indexTree(tree)), [tree]);
  const trees = useMemo(() => (index ? passageTrees(index, passages) : []), [index, passages]);

  useLayoutEffect(() => {
    const count = proseRef.current?.querySelectorAll("[data-passage]").length ?? 0;
    if (count !== passages) setPassages(count);
  }, [tree, passages]);

  const openGroup = useCallback(
    (b: number) => {
      const group = trees.find((t) => t.b === b);
      const first = group?.nodes[0];
      if (!first) return;
      select(thread.id, first.id);
      requestAnimationFrame(() => {
        const row = document.querySelector<HTMLElement>(
          `[data-side="${thread.id}"] [data-row="${first.id}"]`,
        );
        row?.focus({ preventScroll: true });
        row?.closest(".pin")?.scrollIntoView({ block: "nearest" });
      });
    },
    [trees, select, thread.id],
  );

  const groups = useMemo(() => {
    const map = new Map<number, PassageGroup>();
    for (const t of trees)
      map.set(t.b, {
        total: t.total,
        open: () => openGroup(t.b),
        hovered: hovered === t.b,
        onHover: (on) => setHovered(on ? t.b : null),
      });
    return map;
  }, [trees, openGroup, hovered]);

  const quoted =
    ui.composer?.kind === "ask" && ui.composer.parent === "r" && ui.selected === null
      ? (ui.composer.quote?.b ?? 0)
      : null;

  return (
    <FeedRow
      rowId={thread.id}
      side={
        index ? (
          <AskSide
            thread={thread}
            index={index}
            trees={trees}
            proseRef={proseRef}
            channel={view.space}
            now={now}
            hovered={hovered}
            onHover={setHovered}
          />
        ) : null
      }
    >
      <ThreadCard
        view={view}
        now={now}
        index={index}
        groups={groups}
        quoted={quoted}
        proseRef={proseRef}
      />
    </FeedRow>
  );
}

function ThreadCard({
  view,
  now,
  index,
  groups,
  quoted,
  proseRef,
  replyOthers = false,
}: {
  view: ThreadView;
  now: number;
  index?: ReturnType<typeof indexTree> | null;
  groups?: ReadonlyMap<number, PassageGroup>;
  quoted?: number | null;
  proseRef?: React.RefObject<HTMLDivElement | null>;
  replyOthers?: boolean;
}) {
  const { thread, counts, space, saved } = view;
  const { writer, signedOut, signIn, me } = useFeedViewer();
  const writes = useWrites();
  const choice = useRunChoice();
  const navigate = useNavigate();
  const ui = useThreadUi(thread.id);
  const open = useThreadUiStore((state) => state.open);
  const close = useThreadUiStore((state) => state.close);
  const select = useThreadUiStore((state) => state.select);
  const [deleting, setDeleting] = useState(false);
  const [removing, setRemoving] = useState(false);
  const source = useReplicaQuery(
    (s) => (thread.from ? threadOf(s, thread.from.th) : null),
    [thread.from?.th],
  );

  const ask = thread.k === "ask";
  const run = index?.run("r");
  const pending = ask && (thread.running || isActiveRun(run));
  const answer = index?.answerOf("r");
  const mine = me !== null && thread.u === me;
  const hidden = thread.mod === "hidden";
  const r = counts?.r ?? 0;
  const saves = counts?.saves ?? 0;
  const showSaves = showsSaveCount(saves, space?.private ?? false);

  // The "…" menu: Delete for the author (01 C15); Remove… and "Ban from
  // #name" for the channel's owner on another member's thread (W6.5; Ban is
  // a plan addition).
  const actions: MoreAction[] = [];
  if (writer && !mine && space?.owned && thread.u) {
    actions.push({ label: "Remove…", danger: true, onSelect: () => setRemoving(true) });
    const author = thread.u;
    actions.push({
      label: `Ban from #${space.name}`,
      danger: true,
      onSelect: () =>
        void writes
          .send("members.ban", { space: space.id, user: author })
          .then((o) => o.ok && showToast(`Banned @${author} from #${space.name}.`)),
    });
  }
  if (mine) {
    const reason = pending
      ? "Available when the answer finishes"
      : (ask ? index !== null && index !== undefined && othersUnder(index, "r", me) : replyOthers)
        ? "Not available once someone else has responded"
        : undefined;
    actions.push({
      label: ask ? "Delete ask" : "Delete post",
      danger: true,
      disabledReason: reason,
      onSelect: () => setDeleting(true),
    });
  }

  // The follow-up or Reply button (`rbtn`).
  const composerOpen =
    ui.composer !== null &&
    (ask
      ? ui.composer.kind === "ask" && ui.selected === null
      : ui.composer.kind === "reply" && ui.composer.parent === null);
  const followUp = () => {
    if (ask) {
      if (composerOpen) {
        const field = document.querySelector<HTMLTextAreaElement>(
          `[data-side="${thread.id}"] .pin textarea`,
        );
        if (!field || !field.value.trim()) close(thread.id);
        else field.focus();
        return;
      }
      open(thread.id, { kind: "ask", parent: "r" }, null);
    } else {
      if (!composerOpen) open(thread.id, { kind: "reply", parent: null });
      else
        document
          .querySelector<HTMLTextAreaElement>(`[data-side="${thread.id}"] .rfoot ~ .icomp textarea`)
          ?.focus();
    }
  };
  const label = ask ? "Ask a follow-up" : "Reply";
  const countLabel = r
    ? `, ${ask ? noun(r, "branch", "branches") : noun(r, "reply", "replies")}`
    : "";
  const gate = signedOut
    ? { onClick: signIn }
    : writer
      ? { onClick: followUp }
      : { disabled: true, title: `${label} opens once you have an invite` };

  const saveGate = signedOut
    ? { onClick: signIn }
    : writer
      ? { onClick: () => void writes.save(thread.id, !saved) }
      : { disabled: true, title: "Saving opens once you have an invite" };

  return (
    <article className="tcard" id={`card-${thread.id}`} data-thread={thread.id}>
      {source !== UNKNOWN && source && thread.from ? (
        <button
          type="button"
          className="fromln"
          onClick={() =>
            void navigate({
              to: source.space ? "/c/$name" : "/",
              params: source.space ? { name: source.space.name } : {},
              search: { t: source.thread.id, sel: thread.from?.node },
            } as never)
          }
        >
          <ReplyArrowIcon />
          <span>
            Branched from <b>{clip(source.thread.q, 70)}</b>
          </span>
        </button>
      ) : null}
      <div className="tt">
        <span className="ttn" aria-hidden="true" />
        <p className="tt-title">{hidden && !thread.q ? "Hidden by the channel owner" : thread.q}</p>
        {!ask ? <span className="ttm">#{space?.name ?? ""}</span> : null}
        <span className="ttav" title={`${thread.u ?? ""} · ${relTime(thread.createdAt, now)}`}>
          <Avatar handle={thread.u ?? "?"} size="sm" />
        </span>
        <MoreMenu actions={actions} />
      </div>
      {hidden && thread.q ? <p className="hiddenln">Hidden by the channel owner</p> : null}
      {ask ? (
        pending ? (
          <div className="answer">
            <p>
              <RunStatus run={run} />
            </p>
          </div>
        ) : (
          <>
            <AnswerProse
              md={answer?.md ?? ""}
              pages={answer?.pages ?? []}
              groups={groups}
              quoted={quoted}
              proseRef={proseRef}
              id={`pr-${thread.id}`}
            />
            {proseRef ? (
              <SelectionActions
                proseRef={proseRef}
                enabled={writer && !pending}
                onBranch={({ text, b }) =>
                  open(
                    thread.id,
                    { kind: "ask", parent: "r", quote: { text, b, open: false } },
                    null,
                  )
                }
                onLookUp={({ text, b, look }) => {
                  close(thread.id);
                  void writes
                    .lookUp({
                      thread: thread.id,
                      look,
                      quote: text.slice(0, 2000),
                      ...(b !== null ? { b } : {}),
                      model: choice.model,
                      effort: choice.effort,
                    })
                    .then((id) => {
                      if (id) select(thread.id, id);
                    });
                }}
              />
            ) : null}
          </>
        )
      ) : null}
      <div className="card-f">
        <span className="notes">
          {ask ? (
            <span className="fmeta">{footerMeta(thread.src, thread.tok, space?.name ?? null)}</span>
          ) : null}
        </span>
        {ask && pending ? null : (
          <button
            type="button"
            className={cn("ibtn cnt rcount", composerOpen && "on")}
            aria-pressed={composerOpen}
            aria-label={`${label}${countLabel}`}
            title={label}
            {...gate}
          >
            <ReplyArrowIcon />
            {r ? <span>{r}</span> : null}
          </button>
        )}
        <button
          type="button"
          className={cn("ibtn cnt fill", saved && "on")}
          aria-pressed={saved}
          aria-label={`${saved ? "Saved" : "Save"}${showSaves ? `, saved by ${saves}` : ""}`}
          title={saved ? "Saved" : "Save"}
          {...saveGate}
        >
          <SaveIcon />
          {showSaves ? <span>{saves}</span> : null}
        </button>
      </div>
      <ConfirmDelete
        open={deleting}
        onOpenChange={setDeleting}
        title="Delete this thread?"
        onConfirm={() => void writes.deleteThread(thread.id)}
      />
      {space?.owned ? (
        <RemoveDialog thread={thread} open={removing} onOpenChange={setRemoving} />
      ) : null}
    </article>
  );
}
