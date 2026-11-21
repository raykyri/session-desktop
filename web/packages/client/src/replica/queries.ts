// The named queries the screens read (02 §9.1, 01 Y12). Each is a pure
// function of a `ReplicaSource` (exported for tests and for non-React
// callers) and a hook over it. Per-viewer fields (`joined`, `owned`,
// `saved`, `mine`) are computed here from the viewer's own records, never
// stored (01 U1). A read the replica has not loaded stops the query
// (`known`, `source.ts`): the hook answers `UNKNOWN` and the screen shows a
// loading row.

import {
  answerKey,
  countsKey,
  memberKey,
  prefsKey,
  saveKey,
  spaceKey,
  threadKey,
  type AnswerRec,
  type CommentRec,
  type CountsRec,
  type NodeRec,
  type ReplyRec,
  type RunRec,
  type SpaceRec,
  type ThreadRec,
} from "@session/mutators";
import { useSyncExternalStore } from "react";

import { useReplica, useReplicaQuery } from "./ReplicaProvider.js";
import { NotLoaded, known, loose, type ReplicaSource, type Unknown } from "./source.js";

const byCreation = <T extends { createdAt: string; id?: string }>(a: T, b: T) =>
  a.createdAt === b.createdAt
    ? (a.id ?? "") < (b.id ?? "")
      ? -1
      : 1
    : a.createdAt < b.createdAt
      ? -1
      : 1;

// ---- channels ----

export interface ChannelView {
  id: string;
  name: string;
  desc: string;
  private: boolean;
  owner: string;
  members: number;
  frozen: boolean;
  /** The viewer is a member. */
  joined: boolean;
  /** The viewer owns it. */
  owned: boolean;
}

/** Whether `me` is a member of `sp`. The membership records are the user
 * log's, so an unloaded one reads as not a member. */
function isMember(source: ReplicaSource, sp: string): boolean {
  const me = source.me;
  return me !== null && loose(source.get(memberKey(sp, me)))?.kind === "member";
}

export function channelView(source: ReplicaSource, s: SpaceRec): ChannelView {
  const me = source.me;
  return {
    id: s.id,
    name: s.name,
    desc: s.desc,
    private: s.vis === "private",
    owner: s.owner,
    members: s.members,
    frozen: s.frozen,
    joined: isMember(source, s.id),
    owned: me !== null && s.owner === me,
  };
}

/** Every channel the viewer can read about, in the order they were made. */
export function channelsOf(source: ReplicaSource): ChannelView[] {
  return source
    .all("space")
    .sort((a, b) =>
      a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1,
    )
    .map((s) => channelView(source, s));
}

export function useChannels(): ChannelView[] | Unknown {
  return useReplicaQuery(channelsOf, []);
}

/** The channel of a name; null only once the replica has every space it
 * may read and has asked the server for the name (a private channel's
 * landing). */
export function channelByName(source: ReplicaSource, name: string): ChannelView | null {
  const s = source.all("space").find((x) => x.name === name);
  if (s) return channelView(source, s);
  if (!source.complete("space")) throw new NotLoaded();
  if (source.lookUp && !source.lookUp(name)) throw new NotLoaded();
  return null;
}

export function useChannelByName(name: string | null): ChannelView | null | Unknown {
  return useReplicaQuery((source) => (name ? channelByName(source, name) : null), [name]);
}

export function useChannelById(id: string): ChannelView | null | Unknown {
  return useReplicaQuery(
    (source) => {
      const s = known(source.get(spaceKey(id)));
      return s?.kind === "space" ? channelView(source, s) : null;
    },
    [id],
  );
}

// ---- feeds ----

export type FeedKind = { kind: "home" } | { kind: "saved" } | { kind: "channel"; id: string };

const newestFirst = (a: ThreadRec, b: ThreadRec) => -byCreation(a, b);

/** A feed's thread ids, newest first. Home is the threads of the viewer's
 * channels (signed out: of the open channels) that are loaded, `UNKNOWN`
 * while none is; Saved the viewer's saved threads that are loaded; a
 * channel its threads, `UNKNOWN` while its index is not loaded. A thread
 * deleted with nothing under it (`gone`) is left out. */
export function feedOf(source: ReplicaSource, feed: FeedKind): string[] {
  let threads: ThreadRec[] = [];
  if (feed.kind === "channel") threads = known(source.list("thread", { sp: feed.id }));
  else if (feed.kind === "saved") {
    const me = source.me;
    if (me !== null)
      for (const save of known(source.list("save", { u: me }))) {
        const t = loose(source.get(threadKey(save.th)));
        if (t?.kind === "thread") threads.push(t);
      }
  } else {
    const me = source.me;
    const spaces = source
      .all("space")
      .filter((s) => (me === null ? s.vis === "open" : isMember(source, s.id)));
    let loaded = 0;
    for (const s of spaces) {
      const list = loose(source.list("thread", { sp: s.id }));
      if (!list) continue;
      loaded += 1;
      threads.push(...list);
    }
    if (spaces.length > 0 && loaded === 0) throw new NotLoaded();
  }
  return threads
    .filter((t) => !t.gone)
    .sort(newestFirst)
    .map((t) => t.id);
}

export function useFeed(feed: FeedKind): string[] | Unknown {
  return useReplicaQuery((source) => feedOf(source, feed), [feed]);
}

// ---- one thread ----

export interface ThreadView {
  thread: ThreadRec;
  counts: CountsRec | null;
  space: ChannelView | null;
  saved: boolean;
}

/** A thread with its counts and channel; null when known absent. */
export function threadOf(source: ReplicaSource, id: string): ThreadView | null {
  const thread = known(source.get(threadKey(id)));
  if (thread?.kind !== "thread") return null;
  const counts = known(source.get(countsKey(id)));
  const space = known(source.get(spaceKey(thread.s)));
  const me = source.me;
  return {
    thread,
    counts: counts?.kind === "counts" ? counts : null,
    space: space?.kind === "space" ? channelView(source, space) : null,
    saved: me !== null && loose(source.get(saveKey(me, id)))?.kind === "save",
  };
}

export function useThread(id: string): ThreadView | null | Unknown {
  return useReplicaQuery((source) => threadOf(source, id), [id]);
}

/** An ask's tree: its nodes in creation order, the answers and runs of the
 * root and of every node. */
export interface AskTree {
  nodes: NodeRec[];
  answers: Record<string, AnswerRec>;
  runs: Record<string, RunRec>;
  comments: CommentRec[];
}

export function askTreeOf(source: ReplicaSource, th: string): AskTree {
  const nodes = [...known(source.list("node", { th }))].sort(byCreation);
  const answers: Record<string, AnswerRec> = {};
  const runs: Record<string, RunRec> = {};
  const root = known(source.get(answerKey(th)));
  if (root?.kind === "answer") answers["r"] = root;
  for (const n of nodes) {
    const a = known(source.get(answerKey(n.id)));
    if (a?.kind === "answer") answers[n.id] = a;
  }
  for (const run of known(source.list("run", { th }))) {
    const node = run.node;
    const current = runs[node];
    if (!current || current.createdAt <= run.createdAt) runs[node] = run;
  }
  const comments = [...known(source.list("comment", { th }))].sort(byCreation);
  return { nodes, answers, runs, comments };
}

export function useAskTree(th: string): AskTree | Unknown {
  return useReplicaQuery((source) => askTreeOf(source, th), [th]);
}

export function repliesOf(source: ReplicaSource, th: string): ReplyRec[] {
  return [...known(source.list("reply", { th }))].sort(byCreation);
}

export function useReplies(th: string): ReplyRec[] | Unknown {
  return useReplicaQuery((source) => repliesOf(source, th), [th]);
}

// ---- the viewer's own records ----

/** How many of the viewer's runs are waiting to start (03 L1). */
export function queuedRunsOf(source: ReplicaSource): number {
  const me = source.me;
  if (me === null) return 0;
  return (loose(source.list("run", { u: me })) ?? []).filter((r) => r.status === "queued").length;
}

export function savedCountOf(source: ReplicaSource): number {
  const me = source.me;
  if (me === null) return 0;
  return known(source.list("save", { u: me })).filter((s) => {
    const t = loose(source.get(threadKey(s.th)));
    return t === undefined || (t.kind === "thread" && !t.gone);
  }).length;
}

export function unreadCountOf(source: ReplicaSource): number {
  const me = source.me;
  if (me === null) return 0;
  return known(source.list("notif", { u: me })).filter((n) => !n.read).length;
}

export function layoutOf(source: ReplicaSource): "centred" | "wide" | null {
  const me = source.me;
  if (me === null) return null;
  const prefs = known(source.get(prefsKey(me)));
  return prefs?.kind === "prefs" ? prefs.layout : null;
}

export function usePrefsLayout(): "centred" | "wide" | null | Unknown {
  return useReplicaQuery(layoutOf, []);
}

// ---- the clock ----

/** The replica's clock rounded down to the minute: relative times ("18m")
 * change at most once a minute, and a write does not re-render every row. */
const MINUTE = 60_000;

const clockListeners = new Set<() => void>();
let clockTimer: ReturnType<typeof setInterval> | undefined;

function subscribeClock(listener: () => void) {
  clockListeners.add(listener);
  if (clockTimer === undefined) {
    clockTimer = setInterval(() => {
      for (const l of clockListeners) l();
    }, 15_000);
    (clockTimer as { unref?: () => void }).unref?.();
  }
  return () => {
    clockListeners.delete(listener);
    if (clockListeners.size === 0 && clockTimer !== undefined) {
      clearInterval(clockTimer);
      clockTimer = undefined;
    }
  };
}

/** The replica's clock, to the minute; advances while the page is idle. */
export function useNow(): number {
  const source = useReplica();
  return useSyncExternalStore(subscribeClock, () => Math.floor(source.now() / MINUTE) * MINUTE);
}
