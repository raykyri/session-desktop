// The stored shape: what mutators write and what snapshots and pulls carry.
// Fields follow the mock's records (`docs/mockups/session-web-spaces-mock-api.js`
// section 3, `web/packages/shared/src/schemas/spaces.ts`) with these changes for
// a multi-user server:
//
// - Every record has `kind` and an integer `rev`, which the store sets on each
//   write. Counts (`likes`, `r`, `members`, `posts`) are stored fields that
//   mutators maintain; no field is derived on read, and per-viewer fields
//   (`liked`, `mine`) are left to the client.
// - Optional fields are `null` when absent, so two writes of the same state
//   produce equal records.
// - The mock's per-person collections (`joined`, `rel`, `roles`, `liked`,
//   `saved`) become records keyed by person: `member`, `like` and `save`. A
//   space's member list is one `member` record per person; the staff list a
//   non-member may read is the space record's `mods`.
// - A moderation state is the moderated record's `mod` field instead of the
//   mock's separate `modSt` map, so a pull of the record alone serves the
//   redacted form.
// - Space ids are ULIDs (AGENTS.md); the mock's `sp-<name>` slugs are not used.
// - A space's rules version is an integer `rulesRev` instead of `rulesAt`.
// - A space's activity (its thread count and the time of its last thread) is
//   a separate `stats` record that only the space's readers get. The space
//   record is public, so it carries nothing that changes when someone posts.
// - A moderated record's text is erased from storage when it is removed; a
//   hidden record keeps its text, and `view` decides who gets it.

import type { Spaces } from "@session/shared";

/** A change log: one per space and one per user. */
export type LogId = `space:${string}` | `user:${string}`;

export type SpaceRole = Spaces.SpaceMemberRole;
export type ModState = "hidden" | "removed";
export type Visibility = "open" | "listed" | "unlisted";

export interface SpaceRec {
  kind: "space";
  id: string;
  name: string;
  title: string;
  desc: string;
  rules: string[];
  /** The rules' version: counts the saves that changed them. */
  rulesRev: number;
  vis: Visibility;
  policy: "request" | "invite" | null;
  invite: "mods" | "members" | null;
  qs: { q: string; req: boolean }[];
  postsOff: boolean;
  /** Stored count of member records. Public, as on the mock's landing. */
  members: number;
  /** The owner, admins and moderators (the staff list), by rank then handle.
   * Public with the space record. */
  mods: [string, SpaceRole][];
  createdAt: string;
  rev: number;
}

/** A space's activity, read with its content: by everyone for an open space,
 * by members for a closed one. Keyed `stats:<space>`. */
export interface StatsRec {
  kind: "stats";
  sp: string;
  /** Stored count of threads. */
  posts: number;
  /** The time of the last thread, or the space's creation. */
  updatedAt: string;
  rev: number;
}

export interface MemberRec {
  kind: "member";
  sp: string;
  u: string;
  role: SpaceRole;
  joinedAt: string;
  rev: number;
}

export interface ThreadRec {
  kind: "thread";
  id: string;
  s: string;
  u: string;
  k: "ask" | "post";
  q: string;
  t: string | null;
  sum: string | null;
  tok: number;
  /** Stored count of like records. */
  likes: number;
  /** Stored count of follow-ups (an ask) or top-level replies (a post). */
  r: number;
  running: boolean;
  edited: boolean;
  del: boolean;
  gone: boolean;
  mod: ModState | null;
  createdAt: string;
  updatedAt: string;
  rev: number;
}

export interface FollowUpRec {
  kind: "followup";
  id: string;
  th: string;
  s: string;
  u: string;
  q: string;
  a: string | null;
  mod: ModState | null;
  createdAt: string;
  rev: number;
}

export interface ReplyRec {
  kind: "reply";
  id: string;
  th: string;
  s: string;
  u: string;
  t: string;
  /** The top-level reply this one answers (one level of nesting), or null. */
  parent: string | null;
  mod: ModState | null;
  createdAt: string;
  rev: number;
}

/** A run of a thread's ask, queued by `threads.create`; a server job takes
 * it from there (not modelled). Its id is derived from the mutation id. */
export interface RunRec {
  kind: "run";
  id: string;
  th: string;
  s: string;
  u: string;
  node: "r";
  status: "queued";
  attempt: number;
  createdAt: string;
  rev: number;
}

export interface ReportRec {
  kind: "report";
  id: string;
  sp: string;
  key: string;
  by: string;
  st: "open";
  why: string;
  note: string;
  createdAt: string;
  rev: number;
}

export interface RequestRec {
  kind: "request";
  sp: string;
  u: string;
  st: "open" | "approved" | "declined";
  a: string[];
  why: string | null;
  createdAt: string;
  updatedAt: string;
  rev: number;
}

export interface BanRec {
  kind: "ban";
  id: string;
  sp: string;
  u: string;
  createdAt: string;
  rev: number;
}

export interface InviteRec {
  kind: "invite";
  id: string;
  /** Server-made in the pre-check stage; never from the client. */
  code: string;
  by: string;
  sp: string;
  expiresAt: string | null;
  dead: string | null;
  usedBy: string | null;
  createdAt: string;
  rev: number;
}

export interface LikeRec {
  kind: "like";
  u: string;
  th: string;
  createdAt: string;
  rev: number;
}

export interface SaveRec {
  kind: "save";
  u: string;
  th: string;
  createdAt: string;
  rev: number;
}

/** A notification the server writes after a commit (a post-commit effect). */
export interface NotifRec {
  kind: "notif";
  id: string;
  to: string;
  type: "report";
  sp: string;
  report: string;
  item: string;
  read: boolean;
  createdAt: string;
  rev: number;
}

export type StoredRecord =
  | SpaceRec
  | StatsRec
  | MemberRec
  | ThreadRec
  | FollowUpRec
  | ReplyRec
  | RunRec
  | ReportRec
  | RequestRec
  | BanRec
  | InviteRec
  | LikeRec
  | SaveRec
  | NotifRec;

export type Kind = StoredRecord["kind"];
export type RecordOf<K extends Kind> = Extract<StoredRecord, { kind: K }>;
/** A record as a mutator writes it: the store sets `rev`. */
export type Draft<R extends StoredRecord = StoredRecord> = R extends unknown
  ? Omit<R, "rev">
  : never;

/** Kinds whose records carry an id that a client or the server chose. The
 * other kinds are keyed by the records they relate (`member:<space>:<user>`). */
export const ID_KINDS: ReadonlySet<Kind> = new Set<Kind>([
  "space",
  "thread",
  "followup",
  "reply",
  "run",
  "report",
  "invite",
  "notif",
]);

export const spaceKey = (id: string) => `space:${id}`;
export const statsKey = (sp: string) => `stats:${sp}`;
export const memberKey = (sp: string, u: string) => `member:${sp}:${u}`;
export const threadKey = (id: string) => `thread:${id}`;
export const requestKey = (sp: string, u: string) => `request:${sp}:${u}`;
export const banKey = (sp: string, u: string) => `ban:${sp}:${u}`;
export const likeKey = (u: string, th: string) => `like:${u}:${th}`;
export const saveKey = (u: string, th: string) => `save:${u}:${th}`;

export function keyOf(r: Draft | StoredRecord): string {
  switch (r.kind) {
    case "stats":
      return statsKey(r.sp);
    case "member":
      return memberKey(r.sp, r.u);
    case "request":
      return requestKey(r.sp, r.u);
    case "ban":
      return banKey(r.sp, r.u);
    case "like":
      return likeKey(r.u, r.th);
    case "save":
      return saveKey(r.u, r.th);
    default:
      return `${r.kind}:${r.id}`;
  }
}

/** The id a record holds in the global id registry, if its kind has one. */
export function idOf(r: Draft | StoredRecord): string | null {
  return ID_KINDS.has(r.kind) && "id" in r ? r.id : null;
}

/** The space a record belongs to, or null for a person's own records. */
export function spaceOf(r: Draft | StoredRecord): string | null {
  switch (r.kind) {
    case "space":
      return r.id;
    case "thread":
    case "followup":
    case "reply":
    case "run":
      return r.s;
    case "stats":
    case "member":
    case "report":
    case "request":
    case "ban":
    case "invite":
      return r.sp;
    case "like":
    case "save":
    case "notif":
      return null;
  }
}

/** The person whose user log holds a record, or null. */
export function personOf(r: Draft | StoredRecord): string | null {
  switch (r.kind) {
    case "member":
    case "request":
    case "like":
    case "save":
      return r.u;
    case "report":
      return r.by;
    case "notif":
      return r.to;
    default:
      return null;
  }
}

/** The logs a record is written to: its space's log, and the user log of the
 * person it belongs to (a membership, a join request, a report, a like, a
 * save, a notification). */
export function logsOf(r: Draft | StoredRecord): LogId[] {
  const out: LogId[] = [];
  const sp = spaceOf(r);
  if (sp !== null) out.push(`space:${sp}`);
  const u = personOf(r);
  if (u !== null) out.push(`user:${u}`);
  return out;
}

/** The fields that decide who may read a record: its kind, space, person,
 * author and maker. A write never changes them (`Tx.put` checks), so an edit
 * never moves a record to another audience. */
export function audienceOf(r: Draft | StoredRecord): string {
  return JSON.stringify([
    r.kind,
    spaceOf(r),
    personOf(r),
    "u" in r ? r.u : null,
    "by" in r ? r.by : null,
  ]);
}

/** The server's creation time of a record (a member record's `joinedAt`), or
 * "" for a record without one. */
export function createdOf(r: StoredRecord): string {
  if ("createdAt" in r) return r.createdAt;
  if (r.kind === "member") return r.joinedAt;
  return "";
}
