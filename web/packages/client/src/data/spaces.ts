// What the screens show, as pure functions over the records a reader holds
// (`Reader`) and the space directory: spaces and the person's place in them,
// feeds, a thread with its answer, follow-ups and replies, notifications and
// saved threads. Each answers plain JSON, so a query re-renders only when its
// answer changes.

import type * as pkg from "@session/mutators";

import type { Reader } from "../sync/reader.js";
import type { Directory } from "../sync/session.js";

export type Role = pkg.SpaceRole;

/** A space as a screen shows it: its record and its activity. */
export interface Space {
  id: string;
  name: string;
  title: string;
  desc: string;
  vis: pkg.Visibility;
  policy: "request" | "invite" | null;
  invite: "mods" | "members" | null;
  av: number;
  img: boolean;
  dom: pkg.SpaceDomain | null;
  plain: boolean;
  faq: boolean;
  topics: [string, string][];
  postsOff: boolean;
  rules: string[];
  mods: [string, Role][];
  members: number;
  /** Threads, from its stats (null where the reader may not read them). */
  posts: number | null;
  archived: boolean;
  createdAt: string;
}

function toSpace(s: pkg.SpaceRec, stats: pkg.StatsRec | undefined): Space {
  return {
    id: s.id,
    name: s.name,
    title: s.title,
    desc: s.desc,
    vis: s.vis,
    policy: s.policy,
    invite: s.invite,
    av: s.av,
    img: s.img,
    dom: s.dom,
    plain: s.plain,
    faq: s.faq,
    topics: s.topics,
    postsOff: s.postsOff,
    rules: s.rules,
    mods: s.mods,
    members: s.members,
    posts: stats ? stats.posts : null,
    archived: s.archived !== null,
    createdAt: s.createdAt,
  };
}

/** Every space the reader knows: the directory's, each replaced by the
 * replica's record where a log holds it (newer), plus the replica's spaces
 * the directory does not list (an unlisted space shown by a link). */
export function spacesOf(r: Reader, dir: Directory | undefined): Space[] {
  const out = new Map<string, Space>();
  const dirStats = new Map((dir?.stats ?? []).map((s) => [s.sp, s]));
  for (const s of dir?.spaces ?? []) out.set(s.id, toSpace(s, dirStats.get(s.id)));
  for (const s of r.list("space")) {
    if (s.deleted) {
      out.delete(s.id);
      continue;
    }
    out.set(s.id, toSpace(s, r.get("stats", s.id) ?? dirStats.get(s.id)));
  }
  return [...out.values()];
}

export const spaceByName = (spaces: readonly Space[], name: string) =>
  spaces.find((s) => s.name === name);

/** The person's role in each space they belong to. */
export function rolesOf(r: Reader): Record<string, Role> {
  const out: Record<string, Role> = {};
  if (!r.me) return out;
  const me = r.me;
  for (const m of r.list("member", (x) => x.u === me)) out[m.sp] = m.role;
  return out;
}

export const isStaff = (role: Role | undefined) =>
  role === "owner" || role === "admin" || role === "mod";

/** Whether the reader reads the space's threads. */
export const readsSpace = (s: Pick<Space, "vis">, role: Role | undefined) =>
  s.vis === "open" || role !== undefined;

/** The header's spaces: the person's, then the others they may read, each
 * group by activity; closed spaces they are not in stay out. */
export function headerSpaces(spaces: readonly Space[], roles: Record<string, Role>): Space[] {
  const byActivity = (a: Space, b: Space) =>
    (b.posts ?? 0) - (a.posts ?? 0) || b.members - a.members || (a.name < b.name ? -1 : 1);
  const mine = spaces.filter((s) => roles[s.id] !== undefined).sort(byActivity);
  const rest = spaces.filter((s) => roles[s.id] === undefined && s.vis === "open").sort(byActivity);
  return [...mine, ...rest];
}

// ---- threads ----

/** A moderator's action on an item, as the feed and the thread show it. */
export type Moderated = "hidden" | "removed" | null;

export interface Row {
  id: string;
  s: string;
  u: string;
  k: "ask" | "post";
  q: string;
  t: string | null;
  sum: string | null;
  /** The answer's first paragraph as plain text (a feed's line). */
  summary: string | null;
  running: boolean;
  del: boolean;
  mod: Moderated;
  /** First-level follow-ups (an ask) or replies (a post). */
  n: number;
  likes: number;
  topic: string | null;
  createdAt: string;
  /** The latest activity: its creation, or its newest follow-up or reply. */
  active: string;
  about: pkg.AskAbout | null;
  skill: string | null;
}

/** An answer's opening as plain text: its first paragraph without Markdown
 * markup or citation markers, at most 280 characters. */
export function summaryOf(md: string | null): string | null {
  if (md === null) return null;
  const para =
    md
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .find((p) => p && !/^(#|```|\||-{3})/.test(p)) ?? "";
  const text = para
    .replace(/\[(\d{1,3})\]\([^)]*\)/g, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^[-*+]\s+/gm, "")
    .replace(/[*_`>#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 280 ? `${text.slice(0, 279).trimEnd()}…` : text;
}

export const moderated = (r: Reader, key: string, mod: pkg.ModState | null): Moderated =>
  mod === "removed" ? "removed" : r.byKey(`hide:${key}`) ? "hidden" : null;

function rowOf(r: Reader, t: pkg.ThreadRec, latest: Map<string, string>): Row {
  const c = r.get("counts", t.id);
  return {
    id: t.id,
    s: t.s,
    u: t.u,
    k: t.k,
    q: t.q,
    t: t.t,
    sum: t.sum,
    summary: summaryOf(t.sum),
    running: t.running,
    del: t.del,
    mod: moderated(r, `thread:${t.id}`, t.mod),
    n: c?.r ?? 0,
    likes: c?.likes ?? 0,
    topic: t.topic,
    createdAt: t.createdAt,
    active: latest.get(t.id) ?? t.createdAt,
    about: t.about,
    skill: t.skill,
  };
}

/** The newest follow-up or reply of each thread held. */
function latestActivity(r: Reader): Map<string, string> {
  const out = new Map<string, string>();
  const bump = (th: string, at: string) => {
    const was = out.get(th);
    if (!was || at > was) out.set(th, at);
  };
  for (const f of r.list("followup")) bump(f.th, f.createdAt);
  for (const x of r.list("reply")) bump(x.th, x.createdAt);
  return out;
}

export type Sort = "Latest" | "Active" | "Most followed";
export const SORTS: [Sort, string][] = [
  ["Latest", "Newest first"],
  ["Active", "Latest follow-up or reply first"],
  ["Most followed", "Most follow-ups and replies"],
];
export type KindFilter = "all" | "ask" | "post";

export function sortRows(rows: Row[], sort: Sort): Row[] {
  const by =
    sort === "Active"
      ? (a: Row, b: Row) => (a.active < b.active ? 1 : a.active > b.active ? -1 : 0)
      : sort === "Most followed"
        ? (a: Row, b: Row) => b.n - a.n || (a.createdAt < b.createdAt ? 1 : -1)
        : (a: Row, b: Row) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0);
  return [...rows].sort(by);
}

/** The threads of some spaces, newest first; a removed thread whose author
 * deleted it with nothing under it is gone. */
export function threadRows(r: Reader, spaces: ReadonlySet<string>): Row[] {
  const latest = latestActivity(r);
  return r
    .list("thread", (t) => spaces.has(t.s) && !t.gone)
    .map((t) => rowOf(r, t, latest))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

// ---- a thread ----

export interface FollowUp {
  id: string;
  par: string | null;
  u: string;
  q: string;
  a: string | null;
  del: boolean;
  edited: boolean;
  mod: Moderated;
  promoted: string | null;
  createdAt: string;
  run: RunView | null;
  saved: boolean;
}

export interface Reply {
  id: string;
  parent: string | null;
  u: string;
  t: string;
  del: boolean;
  edited: boolean;
  mod: Moderated;
  likes: number;
  liked: boolean;
  createdAt: string;
}

export interface RunView {
  id: string;
  status: pkg.RunRec["status"];
  end: pkg.RunEnd | null;
  attempt: number;
  pay: string | null;
  model: string | null;
  device: { cli: "claude" | "codex"; u: string } | null;
  createdAt: string;
  /** The committed turns' text, in order (the answer's progress). */
  turns: unknown[];
}

export interface ThreadView extends Row {
  edited: boolean;
  tok: number;
  pay: string | null;
  model: string | null;
  att: number;
  from: pkg.ThreadRec["from"];
  topicBy: pkg.ThreadRec["topicBy"];
  updatedAt: string;
  liked: boolean;
  saved: boolean;
  askSaved: boolean;
  run: RunView | null;
  followups: FollowUp[];
  replies: Reply[];
}

/** The latest run of a node ("r": the thread's ask, else a follow-up). */
function runOf(r: Reader, th: string, node: string): RunView | null {
  const runs = r.list("run", (x) => x.th === th && x.node === node && x.status !== "cancelled");
  const run = runs.sort((a, b) => b.attempt - a.attempt || (a.createdAt < b.createdAt ? 1 : -1))[0];
  if (!run) return null;
  const turns = r
    .list("turn", (t) => t.run === run.id && t.attempt === run.attempt)
    .sort((a, b) => a.n - b.n)
    .map((t) => t.body);
  return {
    id: run.id,
    status: run.status,
    end: run.end,
    attempt: run.attempt,
    pay: run.pay,
    model: run.model,
    device: run.executor ? { cli: run.executor.cli, u: run.executor.u } : null,
    createdAt: run.createdAt,
    turns,
  };
}

export function threadView(r: Reader, id: string): ThreadView | null {
  const t = r.get("thread", id);
  if (!t) return null;
  const me = r.me;
  const latest = latestActivity(r);
  const counts = r.get("counts", id);
  const followups = r
    .list("followup", (f) => f.th === id)
    .map(
      (f): FollowUp => ({
        id: f.id,
        par: f.par,
        u: f.u,
        q: f.q,
        a: f.a,
        del: f.del,
        edited: f.edited,
        mod: moderated(r, `followup:${f.id}`, f.mod),
        promoted: f.promoted,
        createdAt: f.createdAt,
        run: runOf(r, id, f.id),
        saved: me !== null && r.byKey(`asksave:${me}:${id}:${f.id}`) !== undefined,
      }),
    );
  const replies = r
    .list("reply", (x) => x.th === id)
    .map(
      (x): Reply => ({
        id: x.id,
        parent: x.parent,
        u: x.u,
        t: x.t,
        del: x.del,
        edited: x.edited,
        mod: moderated(r, `reply:${x.id}`, x.mod),
        likes: counts?.rlikes[x.id] ?? 0,
        liked: me !== null && r.byKey(`rlike:${me}:${x.id}`) !== undefined,
        createdAt: x.createdAt,
      }),
    );
  return {
    ...rowOf(r, t, latest),
    edited: t.edited,
    tok: t.tok,
    pay: t.pay,
    model: t.model,
    att: t.att,
    from: t.from,
    topicBy: t.topicBy,
    updatedAt: t.updatedAt,
    liked: me !== null && r.byKey(`like:${me}:${id}`) !== undefined,
    saved: me !== null && r.byKey(`save:${me}:${id}`) !== undefined,
    askSaved: me !== null && r.byKey(`asksave:${me}:${id}:r`) !== undefined,
    run: t.k === "ask" ? runOf(r, id, "r") : null,
    followups,
    replies,
  };
}

// ---- the person's ----

export interface Notification {
  id: string;
  type: pkg.NotifType;
  sp: string | null;
  actor: string | null;
  thread: string | null;
  node: string | null;
  item: string | null;
  report: string | null;
  outcome: pkg.NotifRec["outcome"];
  response: pkg.NotifRec["response"];
  invite: string | null;
  read: boolean;
  createdAt: string;
}

export function notificationsOf(r: Reader): Notification[] {
  if (!r.me) return [];
  const me = r.me;
  return r
    .list("notif", (n) => n.to === me)
    .map((n) => ({
      id: n.id,
      type: n.type,
      sp: n.sp,
      actor: n.actor,
      thread: n.thread,
      node: n.node,
      item: n.item,
      report: n.report,
      outcome: n.outcome,
      response: n.response,
      invite: n.invite,
      read: n.read,
      createdAt: n.createdAt,
    }))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/** Open join requests and open reports per space the person moderates, and
 * whether they read those notices (the `seen` record). */
export function staffNotices(r: Reader, roles: Record<string, Role>) {
  const staffOf = Object.keys(roles).filter((sp) => isStaff(roles[sp]));
  const reqs = staffOf
    .map((sp) => {
      const open = r.list("request", (q) => q.sp === sp && q.st === "open");
      return { sp, n: open.length, at: open.map((q) => q.createdAt).sort()[0] ?? "" };
    })
    .filter((x) => x.n > 0);
  const reps = staffOf
    .map((sp) => {
      const open = r.list("report", (q) => q.sp === sp && q.st === "open");
      return { sp, n: open.length, at: open.map((q) => q.createdAt).sort()[0] ?? "" };
    })
    .filter((x) => x.n > 0);
  const seen = r.me ? r.byKey(`seen:${r.me}`) : undefined;
  return {
    reqs,
    reps,
    reqSeen: seen?.kind === "seen" ? seen.reqs : false,
    repSeen: seen?.kind === "seen" ? seen.reps : false,
  };
}

/** The threads the person saved, newest save first. */
export function savedThreads(r: Reader): { th: string; at: string }[] {
  if (!r.me) return [];
  const me = r.me;
  return r
    .list("save", (x) => x.u === me)
    .map((x) => ({ th: x.th, at: x.createdAt }))
    .sort((a, b) => (a.at < b.at ? 1 : -1));
}
