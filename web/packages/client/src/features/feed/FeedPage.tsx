// A feed (02 §3.1; the mock's `renderNetwork`): the no-invite banner, the
// channel header, the composer, the empty state, one row per thread, and the
// site footer (`FeedFrame`). Home lists the threads of the viewer's channels
// (signed out: the open ones), a channel its own, Saved the saved ones,
// newest first. A thread's address (`?t=&sel=`, decision P9) scrolls its row
// 12 px below the top of the feed, selects the item and flashes the card.

import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

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
import { NewThreadComposer } from "../composer/NewThreadComposer.js";
import { FeedFrame, FeedPlaceholder, FeedRow } from "../shell/Frames.js";
import { showToast } from "../shell/Toast.js";
import { keepBar } from "../shell/useBarAutoHide.js";

import { useFeedViewer } from "./FeedContext.js";
import { ThreadRow } from "./ThreadRow.js";
import { EmptySaveIcon } from "./icons.js";

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
        <h3>Nothing saved yet</h3>
        <p>
          Threads you save appear here, newest first. Save one with the bookmark at the bottom of
          the thread; saving again removes it.
        </p>
        <Link to="/" search={{}} className="btn2 sm">
          Go to Home
        </Link>
      </div>
    </div>
  );
}

/** Scrolls a thread's row into place, selects the item and flashes the
 * card once the row is rendered (02 §2.1, W2.6). */
function useThreadAddress(ids: string[] | null, t: string | undefined, sel: string | undefined) {
  const source = useReplica();
  const select = useThreadUiStore((state) => state.select);
  const done = useRef<string | null>(null);
  useEffect(() => {
    if (!t || !ids) return;
    const key = `${t}:${sel ?? ""}`;
    if (done.current === key) return;
    done.current = key;
    if (!ids.includes(t)) {
      if (!threadOf(source, t)) showToast("This thread is not available.");
      return;
    }
    if (sel) select(t, sel);
    requestAnimationFrame(() => {
      const card = document.getElementById(`card-${t}`);
      const scroller = card?.closest<HTMLElement>("[data-shell-scroll]");
      if (!card || !scroller) return;
      keepBar();
      const top = card.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      scroller.scrollBy({ top: top - 12, behavior: prefersReducedMotion() ? "instant" : "smooth" });
      card.classList.add("flash");
      setTimeout(() => card.classList.remove("flash"), 1600);
    });
  }, [ids, t, sel, source, select]);
}

export function FeedPage({ kind, name, t, sel }: FeedPageProps) {
  const { viewer, writer, signedOut } = useFeedViewer();
  const now = useNow();
  const channel = useReplicaQuery(
    (source) => (kind === "channel" && name ? channelByName(source, name) : null),
    [kind, name],
  );
  const joined = useReplicaQuery(
    (source) => channelsOf(source).filter((c) => c.joined && !c.frozen),
    [],
  );
  const feed: FeedKind | null =
    kind === "channel"
      ? channel && channel !== UNKNOWN
        ? { kind: "channel", id: channel.id }
        : null
      : { kind };
  const ids = useReplicaQuery((source) => (feed ? feedOf(source, feed) : []), [feed]);
  useThreadAddress(ids === UNKNOWN ? null : ids, t, sel);

  if (ids === UNKNOWN || channel === UNKNOWN || joined === UNKNOWN)
    return (
      <FeedFrame channel={kind === "channel"}>
        <FeedPlaceholder />
      </FeedFrame>
    );
  if (kind === "channel" && !channel) return <RouteNotFoundPanel />;

  const ch: ChannelView | null = kind === "channel" ? channel : null;
  const locked = ch !== null && ch.private && !ch.joined;
  const showComposer =
    !locked &&
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
      {showComposer ? (
        <FeedRow lead>
          <NewThreadComposer channel={ch} joined={joined} />
        </FeedRow>
      ) : null}
      {empty ? <FeedRow>{empty}</FeedRow> : null}
      {locked ? null : ids.map((id) => <ThreadRow key={id} id={id} now={now} />)}
    </FeedFrame>
  );
}
