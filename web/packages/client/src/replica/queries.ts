// The named queries the screens read (02 §9.1, 01 Y12). Each is a pure
// function of a `ReplicaSource` (exported for tests and for non-React
// callers) and a hook over it. Per-viewer fields (`joined`, `owned`,
// `saved`, `mine`) are computed here from the viewer's own records, never
// stored (01 U1).

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

import { useReplicaQuery } from "./ReplicaProvider.js";
import type { ReplicaSource, Unknown } from "./source.js";

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

export function channelView(source: ReplicaSource, s: SpaceRec): ChannelView {
  const me = source.me;
  const joined = me !== null && source.get(memberKey(s.id, me))?.kind === "member";
  return {
    id: s.id,
    name: s.name,
    desc: s.desc,
    private: s.vis === "private",
    owner: s.owner,
    members: s.members,
    frozen: s.frozen,
    joined,
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

export function channelByName(source: ReplicaSource, name: string): ChannelView | null {
  const s = source.all("space").find((x) => x.name === name);
  return s ? channelView(source, s) : null;
}

export function useChannelByName(name: string | null): ChannelView | null | Unknown {
  return useReplicaQuery((source) => (name ? channelByName(source, name) : null), [name]);
}

export function useChannelById(id: string): ChannelView | null | Unknown {
  return useReplicaQuery(
    (source) => {
      const s = source.get(spaceKey(id));
      return s?.kind === "space" ? channelView(source, s) : null;
    },
    [id],
  );
}

// ---- feeds ----

export type FeedKind = { kind: "home" } | { kind: "saved" } | { kind: "channel"; id: string };

const newestFirst = (a: ThreadRec, b: ThreadRec) =>
  a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1;

/** A feed's thread ids, newest first. Home is the threads of the viewer's
 * channels (signed out: of the open channels); Saved the viewer's saved
 * threads; a channel its threads. A thread deleted with nothing under it
 * (`gone`) is left out. */
export function feedOf(source: ReplicaSource, feed: FeedKind): string[] {
  let threads: ThreadRec[];
  if (feed.kind === "channel") threads = source.list("thread", { sp: feed.id });
  else if (feed.kind === "saved") {
    const me = source.me;
    threads = [];
    if (me !== null)
      for (const save of source.list("save", { u: me })) {
        const t = source.get(threadKey(save.th));
        if (t?.kind === "thread") threads.push(t);
      }
  } else {
    const me = source.me;
    const spaces = new Set(
      source
        .all("space")
        .filter((s) =>
          me === null ? s.vis === "open" : source.get(memberKey(s.id, me))?.kind === "member",
        )
        .map((s) => s.id),
    );
    threads = source.all("thread").filter((t) => spaces.has(t.s));
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

export function threadOf(source: ReplicaSource, id: string): ThreadView | null {
  const thread = source.get(threadKey(id));
  if (thread?.kind !== "thread") return null;
  const counts = source.get(countsKey(id));
  const space = source.get(spaceKey(thread.s));
  const me = source.me;
  return {
    thread,
    counts: counts?.kind === "counts" ? counts : null,
    space: space?.kind === "space" ? channelView(source, space) : null,
    saved: me !== null && source.get(saveKey(me, id))?.kind === "save",
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
  const nodes = source
    .list("node", { th })
    .sort((a, b) =>
      a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1,
    );
  const answers: Record<string, AnswerRec> = {};
  const runs: Record<string, RunRec> = {};
  const root = source.get(answerKey(th));
  if (root?.kind === "answer") answers["r"] = root;
  for (const n of nodes) {
    const a = source.get(answerKey(n.id));
    if (a?.kind === "answer") answers[n.id] = a;
  }
  for (const run of source.list("run", { th })) {
    const node = run.node;
    const current = runs[node];
    if (!current || current.createdAt <= run.createdAt) runs[node] = run;
  }
  const comments = source
    .list("comment", { th })
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  return { nodes, answers, runs, comments };
}

export function useAskTree(th: string): AskTree | Unknown {
  return useReplicaQuery((source) => askTreeOf(source, th), [th]);
}

export function repliesOf(source: ReplicaSource, th: string): ReplyRec[] {
  return source
    .list("reply", { th })
    .sort((a, b) =>
      a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1,
    );
}

export function useReplies(th: string): ReplyRec[] | Unknown {
  return useReplicaQuery((source) => repliesOf(source, th), [th]);
}

// ---- the viewer's own records ----

export function savedCountOf(source: ReplicaSource): number {
  const me = source.me;
  if (me === null) return 0;
  return source.list("save", { u: me }).filter((s) => {
    const t = source.get(threadKey(s.th));
    return t?.kind === "thread" && !t.gone;
  }).length;
}

export function unreadCountOf(source: ReplicaSource): number {
  const me = source.me;
  if (me === null) return 0;
  return source.list("notif", { u: me }).filter((n) => !n.read).length;
}

export function layoutOf(source: ReplicaSource): "centred" | "wide" | null {
  const me = source.me;
  if (me === null) return null;
  const prefs = source.get(prefsKey(me));
  return prefs?.kind === "prefs" ? prefs.layout : null;
}

export function usePrefsLayout(): "centred" | "wide" | null | Unknown {
  return useReplicaQuery(layoutOf, []);
}

/** The replica's clock, for relative times. Re-read on every change. */
export function useNow(): number {
  return useReplicaQuery((source) => source.now(), []) as number;
}
