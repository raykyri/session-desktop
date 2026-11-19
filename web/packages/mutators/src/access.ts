// Roles and read scope: replica-proto's `access.ts` (the mock's section 5a
// with the phase 0 decisions), extended to the record kinds this package
// adds. A server half filters every read with `view`; mutators use
// `canRead` for their NOT_FOUND checks.
//
// Read rules:
// - Space records and catalog sources are public.
// - An open space's content (threads and their counts, follow-ups, replies,
//   runs, its stats, member list, page list, pages, skills, sources) is
//   readable by anyone, signed out included; a closed space's (`vis` listed
//   or unlisted) by its members only.
// - Join requests: the person's own, and all of them in the spaces they
//   moderate. Reports and source reports: the same, but the person's own
//   only while they may read the space (review round 1 of phase 1, W6).
//   Bans: the spaces they moderate. Invite links: the spaces they moderate,
//   and the links they made while they are a member.
// - A person reads their own membership records.
// - A person's likes, saves (of threads and asks), reply likes and
//   notifications: that person only, and only while they may read the space
//   the record is about. A report notification only while they are staff of
//   its space. An invite notification is the invited person's whatever their
//   access (it is about a space they are not in yet).
// - A person's mutes, blocks, saved and read sources, seen flags, profile
//   and API keys (`apikey`, without the raw key): that person only.
// - A person's invite asks: that person and the space's staff (phase 1a.2,
//   decision 8).
// - A source added to a space: the space's readers. While it waits for
//   review (`rv`), and once a moderator removed it (`rm`), its fields are
//   redacted for everyone but the person who added it and the space's
//   moderators (decision 5): the record keeps one audience, as a hidden
//   thread does, so no write changes who reads it.
// - Text of a hidden thread, follow-up or reply (one with a `hide` record),
//   a thread's `about`, `model` and `skill` and a follow-up's `model`
//   included, and the `model` of the runs of a hidden ask: its author and the
//   space's moderators.
//   Everyone else gets the placeholder (`redact`). A hide record is read with its space's content;
//   a change of it changes how its item reads (`viewDependents`). A removed
//   item's text is erased from storage.
// - A person's devices (`device`, without the token): that person only.
// - How a person's membership of a space ended (`exit`: left or removed):
//   that person only.
// - A device run's device (`executor.device`): the run's person only. So is
//   an `access` end (the person was banned, removed or signed the device
//   out): everyone else reads it as `interrupted` (review round 2 of phase
//   1, W2).

import type {
  FollowUpRec,
  Kind,
  NotifType,
  RecordOf,
  ReplyRec,
  RunRec,
  SourceMeta,
  SpaceRec,
  SpaceRole,
  SpaceSourceRec,
  StoredRecord,
  ThreadRec,
} from "./records.js";
import { personOf, spaceOf } from "./records.js";

/** Reads by kind and id. A mutation's `Tx` is one. */
export interface Reader {
  get<K extends Kind>(kind: K, id: string): RecordOf<K> | undefined;
}

export const RANK: Readonly<Record<SpaceRole, number>> = { member: 1, mod: 2, admin: 3, owner: 4 };

export const isClosed = (s: SpaceRec) => s.vis !== "open";

export function spaceRec(g: Reader, sp: string): SpaceRec | undefined {
  return g.get("space", sp);
}

/** A person's role in a space: their member record's role, or null. */
export function roleIn(g: Reader, sp: string, u: string | null): SpaceRole | null {
  if (u === null) return null;
  return g.get("member", `${sp}:${u}`)?.role ?? null;
}

export const rankIn = (g: Reader, sp: string, u: string | null) => {
  const r = roleIn(g, sp, u);
  return r ? RANK[r] : 0;
};

export const isModOf = (g: Reader, sp: string, u: string | null) => rankIn(g, sp, u) >= RANK.mod;

export const bannedFrom = (g: Reader, sp: string, u: string) =>
  g.get("ban", `${sp}:${u}`) !== undefined;

/** May `u` read a space's content. */
export function readsSpace(g: Reader, sp: string, u: string | null): boolean {
  const s = spaceRec(g, sp);
  if (!s) return false;
  return !isClosed(s) || roleIn(g, sp, u) !== null;
}

/** The fields that decide who reads a record: the part of it a tombstone
 * keeps. `sp` is the space whose rules apply: the record's own space, for a
 * like, save, reply like or saved ask its thread's space, for a
 * notification, an invite ask or an exit the space it is about. `person` is
 * the person whose user log holds it; `by` its author or maker; `type`, on a
 * notification only, its type. */
export interface Audience {
  kind: Kind;
  sp: string | null;
  person: string | null;
  by: string | null;
  type?: NotifType;
}

export function audience(g: Reader, r: StoredRecord): Audience {
  let sp = spaceOf(r);
  if (r.kind === "like" || r.kind === "save" || r.kind === "rlike" || r.kind === "asksave")
    sp = g.get("thread", r.th)?.s ?? null;
  if (r.kind === "notif" || r.kind === "invask" || r.kind === "exit") sp = r.sp;
  const by = "by" in r ? r.by : "u" in r ? r.u : null;
  const a: Audience = { kind: r.kind, sp, person: personOf(r), by };
  if (r.kind === "notif") a.type = r.type;
  return a;
}

/** May `u` read a record with this audience (its text is `redact`'s job). */
export function readsAudience(g: Reader, a: Audience, u: string | null): boolean {
  const sp = a.sp;
  const own = u !== null && a.person === u;
  switch (a.kind) {
    case "space":
    case "source":
      return true;
    case "member":
      return own || (sp !== null && readsSpace(g, sp, u));
    case "stats":
    case "thread":
    case "counts":
    case "followup":
    case "reply":
    case "run":
    case "pages":
    case "page":
    case "skills":
    case "skill":
    case "hide":
      return sp !== null && readsSpace(g, sp, u);
    case "spacesrc":
      // a pending source's fields are `redact`'s job
      return sp !== null && readsSpace(g, sp, u);
    case "report":
    case "srcrep":
      // like a like or a save, a report follows the person's access
      return sp !== null && ((own && readsSpace(g, sp, u)) || isModOf(g, sp, u));
    case "request":
    case "invask":
      return own || (sp !== null && isModOf(g, sp, u));
    case "ban":
      return sp !== null && isModOf(g, sp, u);
    case "invite":
      return (
        sp !== null &&
        (isModOf(g, sp, u) || (u !== null && a.by === u && roleIn(g, sp, u) !== null))
      );
    case "like":
    case "save":
    case "rlike":
    case "asksave":
      return own && (sp === null || readsSpace(g, sp, u));
    case "notif":
      if (!own) return false;
      if (a.type === "invite") return true;
      if (sp === null) return true;
      if (!readsSpace(g, sp, u)) return false;
      return a.type !== "report" || isModOf(g, sp, u);
    case "srcsave":
    case "srcread":
    case "mute":
    case "block":
    case "seen":
    case "profile":
    case "apikey":
    case "device":
    case "exit":
      return own;
  }
}

/** May `u` read the record at all (its text is `redact`'s job). */
export function canRead(g: Reader, r: StoredRecord, u: string | null): boolean {
  return readsAudience(g, audience(g, r), u);
}

/** Whether `u` reads a source added to a space in full: one that is neither
 * waiting for review nor removed, or one they added, or one in a space they
 * moderate. */
export const reviewedFor = (g: Reader, r: SpaceSourceRec, u: string | null) =>
  (!r.rv && !r.rm) || (u !== null && r.by === u) || isModOf(g, r.sp, u);

/** What a pending source's other readers get of its metadata. */
export const PENDING_META: Readonly<SourceMeta> = Object.freeze({
  pl: "",
  form: "",
  au: "",
  h: "",
  len: "",
  tok: 0,
  url: "",
  t: null,
  desc: "",
  sum: "",
  body: [],
});

/** A record as `u` may read its fields: a hidden thread, follow-up or reply
 * keeps its text for its author and the space's moderators; everyone else,
 * and every reader of a removed one, gets the placeholder. A source waiting
 * for review or removed keeps its fields for the person who added it and the
 * space's moderators; everyone else gets its place in the list only. A
 * device run's device id is its person's only. Other records as they are. */
export function redact(g: Reader, r: StoredRecord, u: string | null): StoredRecord {
  if (r.kind === "run") {
    let out: RunRec = r;
    if (r.u !== u) {
      if (r.executor !== null) out = { ...out, executor: { ...r.executor, device: "" } };
      if (r.end === "access") out = { ...out, end: "interrupted" };
    }
    // the model the asker picked is text of the ask: redacted with it
    if (r.model !== null) {
      const n = r.node === "r" ? g.get("thread", r.th) : g.get("followup", r.node);
      if (n && redact(g, n, u) !== n) out = { ...out, model: null };
    }
    return out;
  }
  if (r.kind === "spacesrc")
    return reviewedFor(g, r, u)
      ? r
      : ({ ...r, note: "", meta: { ...PENDING_META }, nurl: null } satisfies SpaceSourceRec);
  if (r.kind !== "thread" && r.kind !== "followup" && r.kind !== "reply") return r;
  if (r.mod === null) {
    if (!isHidden(g, r)) return r;
    if (u !== null && (r.u === u || isModOf(g, r.s, u))) return r;
  }
  switch (r.kind) {
    case "thread":
      return {
        ...r,
        q: "",
        t: null,
        sum: null,
        about: null,
        model: null,
        skill: null,
      } satisfies ThreadRec;
    case "followup":
      return { ...r, q: "", a: null, model: null } satisfies FollowUpRec;
    case "reply":
      return { ...r, t: "" } satisfies ReplyRec;
  }
  return r;
}

/** Whether an item is hidden: it has a `hide` record. */
export function isHidden(g: Reader, r: ThreadRec | FollowUpRec | ReplyRec): boolean {
  return g.get("hide", `${r.kind}:${r.id}`) !== undefined;
}

/** Reads a server half has for `viewDependents`: a record by key, and the
 * runs of a thread. */
export interface DependentSource {
  get(key: string): StoredRecord | undefined;
  runsOf(th: string): readonly StoredRecord[];
}

/** The keys whose view a record's change changes besides its own: a hide
 * record's item (hiding blanks the item's text for most readers, showing
 * gives it back) and, given `src`, the runs of that item's ask, whose
 * `model` is redacted with it (review round 2 of phase 1, H2). A server half
 * writes a log row for each of them in the commit that changes the record,
 * so every reader pulls them again. */
export function viewDependents(r: { kind: Kind }, src?: DependentSource): string[] {
  if (r.kind !== "hide") return [];
  const item = (r as unknown as { item: string }).item;
  if (!src) return [item];
  const x = src.get(item);
  if (x?.kind !== "thread" && x?.kind !== "followup") return [item];
  const th = x.kind === "thread" ? x.id : x.th;
  const node = x.kind === "thread" ? "r" : x.id;
  const runs = src
    .runsOf(th)
    .filter((y): y is RunRec => y.kind === "run" && y.node === node)
    .map((y) => `run:${y.id}`);
  return [item, ...runs];
}

/** A record as `u` may read it now, or null when it is outside their scope. */
export function view(g: Reader, r: StoredRecord, u: string | null): StoredRecord | null {
  return canRead(g, r, u) ? redact(g, r, u) : null;
}
