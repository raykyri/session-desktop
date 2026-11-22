// A feed (02 §3.1; the mock's `renderNetwork`): the no-invite banner, the
// channel header, the composer, the empty state, and one row per thread
// (`FeedFrame`; no site footer). Home lists the threads of the viewer's channels
// (signed out: the open ones), a channel its own, Saved the saved ones,
// newest first. A thread's address (`?t=&sel=`, decision P9) scrolls its row
// 12 px below the top of the feed, selects the item and flashes the card.

import { Link, useNavigate } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";

import { RouteNotFoundPanel } from "../../app/RouteBoundary.js";
import { prefersReducedMotion } from "../../lib/motion.js";
import { useReplica, useReplicaQuery } from "../../replica/ReplicaProvider.js";
import {
  channelByName,
  channelsOf,
  feedOf,
  threadOf,
  useNow,
  type ChannelView,
  type FeedKind,
} from "../../replica/queries.js";
import { UNKNOWN } from "../../replica/source.js";
import { useThreadUiStore } from "../../stores/threadUi.js";
import { ChannelHeader } from "../channels/ChannelHeader.js";
import { FrozenBanner } from "../channels/ChannelInfoDialog.js";
import { useChannelInvite } from "../channels/useChannelInvite.js";
import { NewThreadComposer } from "../composer/NewThreadComposer.js";
import { FeedFrame, FeedPlaceholder, FeedRow } from "../shell/Frames.js";
import { showToast } from "../shell/Toast.js";
import { keepBar } from "../shell/useBarAutoHide.js";

import { useFeedViewer } from "./FeedContext.js";
import { ThreadRow } from "./ThreadRow.js";
import { EmptySaveIcon } from "./icons.js";
import { FLASH_MS, THREAD_UNAVAILABLE, useRevealStore } from "./reveal.js";

export interface FeedPageProps {
  kind: "home" | "saved" | "channel";
  /** The channel's name, for a channel feed. */
  name?: string;
  /** The thread address: the thread to scroll to and the item to select. */
  t?: string | undefined;
  sel?: string | undefined;
}

/** The no-invite banner (`pendingBanner`). */
function PendingBanner() {
  const navigate = useNavigate();
  return (
    <div className="pbanner">
      <span className="pdot" />
      <div>
        <b>You don&apos;t have an invite yet.</b> You can read every open channel. Asking, posting
        and replying open once you enter an invite code.
      </div>
      <button type="button" className="ghost" onClick={() => void navigate({ to: "/welcome" })}>
        Enter a code
      </button>
    </div>
  );
}

function SavedEmpty() {
  return (
    <div className="feed-empty">
      <div className="estate">
        <span className="eic" aria-hidden="true">
          <EmptySaveIcon />
        </span>
        <h3>No saved threads</h3>
        <Link to="/" search={{}} className="btn2 sm">
          Go to Home
        </Link>
      </div>
    </div>
  );
}

/** Lists past this many rows render only the rows near the viewport
 * (W3.1). */
export const VIRTUALISE_FROM = 60;

/** Scrolls the feed so a thread's card sits 12 px below its top, keeping
 * the bar shown (W2.3 `keepBar`), and flashes the card. */
function scrollCardIntoPlace(card: HTMLElement): void {
  const scroller = card.closest<HTMLElement>("[data-shell-scroll]");
  if (!scroller) return;
  keepBar();
  const top = card.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  scroller.scrollBy({ top: top - 12, behavior: prefersReducedMotion() ? "instant" : "smooth" });
  card.classList.add("flash");
  setTimeout(() => card.classList.remove("flash"), FLASH_MS);
}

interface ListHandle {
  /** Brings the row of `id` into the rendered rows; then `onRendered`. */
  reach: (id: string, onRendered: () => void) => void;
}

/** The thread rows, virtualised past `VIRTUALISE_FROM` rows. */
function ThreadList({
  ids,
  now,
  handle,
}: {
  ids: readonly string[];
  now: number;
  handle: React.RefObject<ListHandle | null>;
}) {
  const list = useRef<HTMLDivElement>(null);
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  const [margin, setMargin] = useState(0);
  const virtual = ids.length > VIRTUALISE_FROM;
  // The scroll container, and how far down it the list starts (the rows
  // above it change with the header and composer).
  useLayoutEffect(() => {
    const el = list.current;
    const sc = el?.closest<HTMLElement>("[data-shell-scroll]") ?? null;
    setScroller((prev) => (prev === sc ? prev : sc));
    if (el && sc) {
      const next = el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
      setMargin((prev) => (Math.abs(prev - next) > 0.5 ? next : prev));
    }
  }, [ids, virtual]);
  // TanStack Virtual returns a mutable instance the React compiler cannot
  // memoise; this component is not compiled.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: virtual ? ids.length : 0,
    getScrollElement: () => scroller,
    estimateSize: () => 520,
    overscan: 4,
    scrollMargin: margin,
    getItemKey: (index) => ids[index] ?? index,
  });
  useImperativeHandle(handle, () => ({
    reach: (id, onRendered) => {
      const at = ids.indexOf(id);
      // The row renders on the next frames; wait until it is in the DOM. A
      // list that has just mounted has no scroll element in the first frame,
      // so the scroll is asked for again on each frame until the row is in.
      let tries = 0;
      const step = () => {
        if (document.getElementById(`card-${id}`) || tries++ > 60) {
          onRendered();
          return;
        }
        if (virtual && at >= 0) virtualizer.scrollToIndex(at, { align: "start" });
        requestAnimationFrame(step);
      };
      if (virtual && at >= 0) virtualizer.scrollToIndex(at, { align: "start" });
      requestAnimationFrame(step);
    },
  }));
  if (!virtual)
    return (
      <div ref={list} className="feed-rows">
        {ids.map((id) => (
          <ThreadRow key={id} id={id} now={now} />
        ))}
      </div>
    );
  const items = virtualizer.getVirtualItems();
  return (
    <div
      ref={list}
      className="feed-rows"
      style={{ position: "relative", height: virtualizer.getTotalSize() }}
    >
      {items.map((item) => {
        const id = ids[item.index];
        if (!id) return null;
        return (
          <div
            key={item.key}
            data-index={item.index}
            ref={virtualizer.measureElement}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              transform: `translateY(${item.start - margin}px)`,
            }}
          >
            <ThreadRow id={id} now={now} />
          </div>
        );
      })}
    </div>
  );
}

/** Brings the thread of an address (`?t=&sel=`) or of a request
 * (`revealThread`) into place once its row can be: waits while the thread
 * is not loaded, and says "This thread is not available." when it is known
 * to be absent (02 §2.1): no record, or a thread deleted before anyone
 * replied (`gone`, which no list shows). */
function useReveal(
  ids: string[] | null,
  t: string | undefined,
  sel: string | undefined,
  handle: React.RefObject<ListHandle | null>,
  space: string | undefined,
) {
  const source = useReplica();
  const select = useThreadUiStore((state) => state.select);
  const request = useRevealStore((state) => state.reveal);
  const done = useRevealStore((state) => state.done);
  const handled = useRef<string | null>(null);
  // The address's thread: wanted until handled.
  const target = useMemo(
    () => request ?? (t ? { thread: t, sel, n: -1 } : null),
    [request, t, sel],
  );
  const key = target ? (target.n >= 0 ? `r${target.n}` : `a:${t}:${sel ?? ""}`) : null;
  const status = useReplicaQuery(
    (source) => {
      if (!target) return "none";
      const view = threadOf(source, target.thread);
      return view && !view.thread.gone ? "found" : "absent";
    },
    [target?.thread],
  );
  // A thread outside the window is fetched from its channel's log (02 §2.1,
  // 01 R3); one the replica holds in full needs nothing.
  const wanted = target?.thread;
  const waitsForChannel = ids === null;
  useEffect(() => {
    if (wanted && !waitsForChannel) source.open?.(wanted, space);
  }, [source, wanted, space, waitsForChannel]);
  useEffect(() => {
    if (!target || !key || !ids || handled.current === key) return;
    if (status === UNKNOWN) return;
    if (!ids.includes(target.thread)) {
      if (status === "absent") {
        handled.current = key;
        if (target.n >= 0) done(target.n);
        showToast(THREAD_UNAVAILABLE);
      }
      return;
    }
    handled.current = key;
    if (target.n >= 0) done(target.n);
    if (target.sel) select(target.thread, target.sel);
    handle.current?.reach(target.thread, () => {
      const card = document.getElementById(`card-${target.thread}`);
      if (card) scrollCardIntoPlace(card);
    });
  }, [ids, target, key, status, select, done, handle]);
}

export function FeedPage({ kind, name, t, sel }: FeedPageProps) {
  const { viewer, writer, signedOut } = useFeedViewer();
  const now = useNow();
  const channel = useReplicaQuery(
    (source) => (kind === "channel" && name ? channelByName(source, name) : null),
    [kind, name],
  );
  // The composer's channels: the viewer's; signed out, the open channels
  // its disabled picker shows (the mock's "#public").
  const joined = useReplicaQuery(
    (source) =>
      channelsOf(source).filter((c) =>
        signedOut ? !c.private && !c.frozen : c.joined && !c.frozen,
      ),
    [signedOut],
  );
  const feed: FeedKind | null =
    kind === "channel"
      ? channel && channel !== UNKNOWN
        ? { kind: "channel", id: channel.id }
        : null
      : { kind };
  const ids = useReplicaQuery((source) => (feed ? feedOf(source, feed) : []), [feed]);
  const handle = useRef<ListHandle | null>(null);
  const channelId = channel && channel !== UNKNOWN ? channel.id : undefined;
  useReveal(ids === UNKNOWN ? null : ids, t, sel, handle, channelId);
  // A channel's log is read while its view is open (01 R5).
  const source = useReplica();
  useEffect(() => (channelId ? source.watch?.(channelId) : undefined), [source, channelId]);
  // a channel invite link opened on this page (W6.9)
  useChannelInvite(viewer, channel && channel !== UNKNOWN ? channel : null);

  if (ids === UNKNOWN || channel === UNKNOWN || joined === UNKNOWN)
    return (
      <FeedFrame channel={kind === "channel"}>
        <FeedPlaceholder />
      </FeedFrame>
    );
  if (kind === "channel" && !channel) return <RouteNotFoundPanel />;

  const ch: ChannelView | null = kind === "channel" ? channel : null;
  const locked = ch !== null && ch.private && !ch.joined;
  // a frozen channel takes no new threads (04 B6)
  const showComposer =
    !locked &&
    !ch?.frozen &&
    (signedOut || (writer && (ch === null || ch.joined))) &&
    (ch !== null || joined.length > 0 || signedOut);

  let empty = null;
  if (locked)
    empty = <p className="feed-empty">This channel is private. Ask @{ch.owner} to add you.</p>;
  else if (ids.length === 0) {
    if (kind === "saved") empty = <SavedEmpty />;
    else if (kind === "home")
      empty = (
        <p className="feed-empty">
          Join a few channels to fill Home.{" "}
          <Link to="/browse" className="tlink inl">
            Browse channels
          </Link>
        </p>
      );
    else empty = <p className="feed-empty">No threads here yet. Ask the first question.</p>;
  }

  return (
    <FeedFrame channel={kind === "channel"}>
      {viewer.kind === "waiting" ? (
        <FeedRow lead>
          <PendingBanner />
        </FeedRow>
      ) : null}
      {ch ? (
        <FeedRow lead head>
          <ChannelHeader channel={ch} />
        </FeedRow>
      ) : null}
      {ch?.frozen ? (
        <FeedRow lead>
          <FrozenBanner name={ch.name} />
        </FeedRow>
      ) : null}
      {showComposer ? (
        <FeedRow lead>
          <NewThreadComposer channel={ch} joined={joined} />
        </FeedRow>
      ) : null}
      {empty ? <FeedRow>{empty}</FeedRow> : null}
      {locked ? null : <ThreadList ids={ids} now={now} handle={handle} />}
    </FeedFrame>
  );
}
