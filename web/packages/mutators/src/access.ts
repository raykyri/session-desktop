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
// - Join requests, reports and source reports: the person's own, and all of
//   them in the spaces they moderate. Bans: the spaces they moderate. Invite
//   links: the spaces they moderate, and the links they made while they are
//   a member.
// - A person reads their own membership records.
// - A person's likes, saves (of threads and asks), reply likes and
//   notifications: that person only, and only while they may read the space
//   the record is about. A report notification only while they are staff of
//   its space. An invite notification is the invited person's whatever their
//   access (it is about a space they are not in yet).
// - A person's mutes, blocks, saved and read sources, invite asks, seen
//   flags and profile: that person only.
// - A source added to a space and waiting for review: the person who added
//   it and the space's moderators. This is the one rule that depends on a
//   field a write changes (`rv`), and the change only widens it (approval):
//   no write takes a reader's access to such a record away.
// - Text of a hidden thread, follow-up or reply: its author and the space's
//   moderators. Everyone else gets the placeholder (`redact`). A removed
//   item's text is erased from storage.

import type {
  FollowUpRec,
  Kind,
  NotifType,
  RecordOf,
  ReplyRec,
  SpaceRec,
  SpaceRole,
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
 * like, save, reply like or saved ask its thread's space, for a notification
 * or an invite ask the space it is about. `person` is the person whose user
 * log holds it; `by` its author or maker; `type`, on a notification only,
 * its type. */
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
  if (r.kind === "notif" || r.kind === "invask") sp = r.sp;
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
      return sp !== null && readsSpace(g, sp, u);
    case "spacesrc":
      // a pending source's readers are decided by `canRead`, which sees `rv`
      return sp !== null && readsSpace(g, sp, u);
    case "report":
    case "request":
    case "srcrep":
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
    case "invask":
    case "seen":
    case "profile":
      return own;
  }
}

/** May `u` read the record at all (its text is `redact`'s job). */
export function canRead(g: Reader, r: StoredRecord, u: string | null): boolean {
  if (!readsAudience(g, audience(g, r), u)) return false;
  if (r.kind === "spacesrc" && r.rv) return (u !== null && r.by === u) || isModOf(g, r.sp, u);
  return true;
}

/** A moderated record as `u` may read it: a hidden one keeps its text for its
 * author and the space's moderators; everyone else, and every reader of a
 * removed one, gets the placeholder. Other records as they are. */
export function redact(g: Reader, r: StoredRecord, u: string | null): StoredRecord {
  if (!("mod" in r) || r.mod === null) return r;
  if (r.mod === "hidden" && u !== null && (r.u === u || isModOf(g, r.s, u))) return r;
  switch (r.kind) {
    case "thread":
      return { ...r, q: "", t: null, sum: null } satisfies ThreadRec;
    case "followup":
      return { ...r, q: "", a: null } satisfies FollowUpRec;
    case "reply":
      return { ...r, t: "" } satisfies ReplyRec;
  }
  return r;
}

/** A record as `u` may read it now, or null when it is outside their scope. */
export function view(g: Reader, r: StoredRecord, u: string | null): StoredRecord | null {
  return canRead(g, r, u) ? redact(g, r, u) : null;
}
