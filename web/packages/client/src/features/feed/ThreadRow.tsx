// One feed row (02 §3.1, §3.2): the thread's card, and beside it its side
// column, the branch trees of an ask or the reply tree of a post.
//
// The card (`card`): "Branched from …" on a thread opened from a branch; the
// title drawn as a tree row (hollow node, the question as typed or the
// post's text, the author's avatar with "handle · 3h", the "…" menu); an
// ask's answer; the footer: the meta ("N sources · Nk tokens · #channel" for
// an ask, "#channel" for a post), the follow-up or Reply button with its count, Save
// with its count. A removed thread is its placeholder; a hidden one shows
// its text to its author and the owner under "Hidden by the channel owner".

import { useNavigate } from "@tanstack/react-router";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { cn } from "../../lib/cn.js";
import { prefersReducedMotion } from "../../lib/motion.js";
import { useReplica, useReplicaQuery } from "../../replica/ReplicaProvider.js";
import { askTreeOf, repliesOf, threadOf, type ThreadView } from "../../replica/queries.js";
import { UNAVAILABLE_TEXT, UNKNOWN } from "../../replica/source.js";
import { useWrites } from "../../replica/writes.js";
import { useThreadUi, useThreadUiStore } from "../../stores/threadUi.js";
import { Avatar } from "../../ui/Avatar.js";
import { AskSide } from "../branches/AskSide.js";
import { RunNote, RunProgress, isStoppedRun } from "../branches/RunStatus.js";
import { SelectionActions } from "../branches/SelectionActions.js";
import { indexTree, isActiveRun, othersUnder, passageTrees } from "../branches/tree.js";
import { ConfirmMemberAction } from "../channels/ConfirmMemberAction.js";
import { RemoveDialog } from "../channels/RemoveDialog.js";
import { focusSoon } from "../composer/InlineComposer.js";
import { ReplyTree } from "../replies/ReplyTree.js";
import { FeedRow } from "../shell/Frames.js";
import { NotSentLine } from "../shell/NotSent.js";
import { showToast } from "../shell/Toast.js";

import { AnswerProse, type PassageGroup } from "./AnswerProse.js";
import { FrozenChannel, useFeedViewer, useRunChoice } from "./FeedContext.js";
import { ConfirmDelete } from "./FeedDialog.js";
import { ModerationNote, rowText } from "./Moderated.js";
import { MoreMenu, type MoreAction } from "./MoreMenu.js";
import { authorName, clip, footerMeta, noun, relTime, showsSaveCount } from "./format.js";
import { RemovedIcon, ReplyArrowIcon, SaveIcon } from "./icons.js";

/** A thread's row. Memoised: a row re-renders when its own records change
 * or the clock passes a minute, not when another row's do (W9.1). */
export const ThreadRow = memo(function ThreadRow({ id, now }: { id: string; now: number }) {
  const view = useReplicaQuery((source) => threadOf(source, id), [id]);
  if (view === null) return null;
  if (view === UNKNOWN)
    return (
      <FeedRow rowId={id}>
        <LoadingCard />
      </FeedRow>
    );
  const { thread } = view;
  if (thread.mod === "removed")
    return (
      <FeedRow rowId={id}>
        <RemovedCard view={view} />
      </FeedRow>
    );
  const row =
    thread.k === "post" ? <PostRow view={view} now={now} /> : <AskRow view={view} now={now} />;
  // a frozen channel's threads: the viewer's own Delete, nothing new
  return view.space?.frozen ? <FrozenChannel name={view.space.name}>{row}</FrozenChannel> : row;
});

/** The card after a thread's, for focus once the thread is gone (02 §10.1),
 * else the one before it. */
function nextCardAfter(thread: string): () => HTMLElement | null {
  const row = document.getElementById(`card-${thread}`)?.closest(".feed-row");
  const near = (el: Element | null | undefined) => el?.querySelector<HTMLElement>("article.tcard");
  const next = near(row?.nextElementSibling) ?? near(row?.previousElementSibling);
  const id = next?.id;
  return () => (id ? document.getElementById(id) : null);
}

/** A thread whose records are not loaded yet. */
function LoadingCard() {
  return (
    <div
      role="status"
      aria-label="Loading"
      aria-busy="true"
      data-placeholder=""
      className="tcard bg-surface-card flex flex-col gap-2.5"
    >
      <span className="bg-surface-fill-medium h-3.5 w-3/5 rounded" />
      <span className="bg-surface-fill-subtle h-3 w-full rounded" />
    </div>
  );
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
    <article
      className="tcard removed"
      id={`card-${thread.id}`}
      data-thread={thread.id}
      tabIndex={-1}
    >
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
        onConfirm={() => {
          // The prediction removes the card at once, whether or not the
          // write is sent: focus goes to the next card now (02 §10.1).
          const next = nextCardAfter(thread.id);
          void writes.deleteThread(thread.id);
          focusSoon(next);
        }}
      />
    </article>
  );
}

/** A row whose thread's own records are not loaded (a summary thread, 01
 * R3) asks for them once it renders. True while they could not be fetched
 * (offline, a refused read): the row shows "Available when online." */
function useOpenUnloaded(thread: string, value: unknown): boolean {
  const source = useReplica();
  const unloaded = value === UNKNOWN;
  useEffect(() => {
    if (unloaded) source.open?.(thread);
  }, [source, thread, unloaded]);
  const unavailable = useReplicaQuery((s) => s.unavailable?.(thread) ?? false, [thread]);
  return unloaded && unavailable === true;
}

/** The side column of a summary row whose records could not be fetched. */
function UnavailableNote() {
  return (
    <div className="stick" role="status" data-unavailable="">
      <p className="text-fg-muted text-[13px]">{UNAVAILABLE_TEXT}</p>
    </div>
  );
}

function PostRow({ view, now }: { view: ThreadView; now: number }) {
  const replies = useReplicaQuery((source) => repliesOf(source, view.thread.id), [view.thread.id]);
  const unavailable = useOpenUnloaded(view.thread.id, replies);
  return (
    <FeedRow
      rowId={view.thread.id}
      side={
        replies === UNKNOWN ? (
          unavailable ? (
            <UnavailableNote />
          ) : null
        ) : (
          <div className="stick replies">
            <ReplyTree thread={view.thread} replies={replies} channel={view.space} now={now} />
          </div>
        )
      }
    >
      <ThreadCard
        view={view}
        now={now}
        replyOthers={replies === UNKNOWN ? null : replies.some((r) => r.u !== view.thread.u)}
      />
    </FeedRow>
  );
}

function AskRow({ view, now }: { view: ThreadView; now: number }) {
  const { thread } = view;
  const tree = useReplicaQuery((source) => askTreeOf(source, thread.id), [thread.id]);
  const unavailable = useOpenUnloaded(thread.id, tree);
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
        row?.closest(".pin")?.scrollIntoView({
          block: "nearest",
          behavior: prefersReducedMotion() ? "instant" : "smooth",
        });
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
        unavailable={unavailable}
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
  unavailable = false,
}: {
  view: ThreadView;
  now: number;
  index?: ReturnType<typeof indexTree> | null;
  groups?: ReadonlyMap<number, PassageGroup>;
  quoted?: number | null;
  proseRef?: React.RefObject<HTMLDivElement | null>;
  /** Whether someone else replied to a post; null while the replies are not
   * loaded. */
  replyOthers?: boolean | null;
  /** An ask's records could not be fetched: "Available when online." */
  unavailable?: boolean;
}) {
  const { thread, counts, space, saved } = view;
  const { writer, active, frozen, signedOut, signIn, me } = useFeedViewer();
  const writes = useWrites();
  const choice = useRunChoice();
  const navigate = useNavigate();
  const ui = useThreadUi(thread.id);
  const open = useThreadUiStore((state) => state.open);
  const close = useThreadUiStore((state) => state.close);
  const select = useThreadUiStore((state) => state.select);
  const [deleting, setDeleting] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [banning, setBanning] = useState(false);
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
  const deleted = thread.del;
  const r = counts?.r ?? 0;
  const saves = counts?.saves ?? 0;
  const showSaves = showsSaveCount(saves, space?.private ?? false);

  // The "…" menu: Delete for the author (01 C15); Remove… and "Ban from
  // #name" for the channel's owner on another member's thread (W6.5; Ban is
  // a plan addition).
  const actions: MoreAction[] = [];
  if (writer && !mine && space?.owned && thread.u) {
    actions.push({ label: "Remove…", danger: true, onSelect: () => setRemoving(true) });
    actions.push({
      label: `Ban from #${space.name}`,
      danger: true,
      onSelect: () => setBanning(true),
    });
  }
  const ban = (author: string, channel: { id: string; name: string }) =>
    void writes
      .send("members.ban", { space: channel.id, user: author })
      .then((o) => o.ok && !o.unsent && showToast(`Banned @${author} from #${channel.name}.`));
  // Delete needs to know what is under the thread: not offered while that is
  // not loaded, nor on a deleted thread's shell.
  const others = ask ? (index ? othersUnder(index, "r", me) : null) : replyOthers;
  if (mine && !deleted && others !== null) {
    const reason = pending
      ? "Available when the answer finishes"
      : others
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
      open(thread.id, { kind: "ask", parent: "r", from: null }, null);
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
      : frozen !== null
        ? { disabled: true, title: `#${frozen} is frozen` }
        : { disabled: true, title: `${label} opens once you have an invite` };

  // a save is the viewer's own record: a frozen channel allows it (04 B6)
  const saveGate = signedOut
    ? { onClick: signIn }
    : active
      ? { onClick: () => void writes.save(thread.id, !saved) }
      : { disabled: true, title: "Saving opens once you have an invite" };

  return (
    <article
      className="tcard"
      id={`card-${thread.id}`}
      data-thread={thread.id}
      tabIndex={-1}
      aria-labelledby={`title-${thread.id}`}
    >
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
      {hidden && thread.q ? <ModerationNote mod="hidden" className="hiddenln" /> : null}
      <div className="tt">
        <span className="ttn" aria-hidden="true" />
        <h3 className="tt-title" id={`title-${thread.id}`}>
          {deleted ? "[deleted]" : rowText(thread, thread.q)}
        </h3>
        <span
          className="ttav"
          title={`${authorName(thread.u)} · ${relTime(thread.createdAt, now)}`}
        >
          <Avatar handle={thread.u} size="sm" />
          <span className="sr-only">
            {authorName(thread.u)}, {relTime(thread.createdAt, now)}
          </span>
        </span>
        <MoreMenu actions={actions} />
      </div>
      {ask ? (
        !index ? (
          unavailable ? (
            <div className="answer text-fg-muted" role="status" data-unavailable="">
              {UNAVAILABLE_TEXT}
            </div>
          ) : (
            <div className="answer" role="status" aria-label="Loading" aria-busy="true" />
          )
        ) : pending || (isStoppedRun(run) && !answer) ? (
          <div className="answer">
            <RunProgress thread={thread.id} node="r" run={run} />
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
            <RunNote run={run} />
            {proseRef ? (
              <SelectionActions
                proseRef={proseRef}
                enabled={writer && !pending}
                onBranch={({ text, b }) =>
                  open(
                    thread.id,
                    { kind: "ask", parent: "r", from: null, quote: { text, b, open: false } },
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
          <span className="fmeta">
            {ask
              ? footerMeta(thread.src, thread.tok, space?.name ?? null)
              : footerMeta(0, 0, space?.name ?? null)}
          </span>
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
      <NotSentLine item={thread.id} />
      <ConfirmDelete
        open={deleting}
        onOpenChange={setDeleting}
        title="Delete this thread?"
        onConfirm={() => {
          // The prediction removes the card at once, whether or not the
          // write is sent: focus goes to the next card now (02 §10.1).
          const next = nextCardAfter(thread.id);
          void writes.deleteThread(thread.id);
          focusSoon(next);
        }}
      />
      {space?.owned ? (
        <RemoveDialog thread={thread} open={removing} onOpenChange={setRemoving} />
      ) : null}
      {space?.owned && thread.u && !mine ? (
        <ConfirmMemberAction
          action="ban"
          user={thread.u}
          channel={space}
          open={banning}
          onOpenChange={setBanning}
          onConfirm={() => thread.u && ban(thread.u, space)}
        />
      ) : null}
    </article>
  );
}
