// The stored shape: what mutators write and what snapshots and pulls carry.
// The record types are the shared contract's (`Spaces.*Record`, from
// `web/packages/shared/src/schemas/spaces.ts`), which this prototype writes
// and the suite parses every stored record with. Notes for a multi-user
// server:
//
// - Every record has `kind` and an integer `rev`, which the store sets on each
//   write. A record written again at a key that was deleted continues from
//   the key's last rev. Counts (`saves`, `r`, `members`, `posts`) are stored
//   fields that mutators maintain; no field is derived on read, and
//   per-viewer fields (`saved`, `mine`) are left to the client. There are no
//   likes.
// - A thread's save and branch counts are a separate `counts` record, so a
//   save or a branch does not change the thread's rev, and an owner's queued
//   "shown" based on that rev stays valid.
// - Optional fields are `null` when absent, so two writes of the same state
//   produce equal records.
// - Per-person records (`member`, `save`, `notif`, `prefs`, and the
//   prototype's `request`) live in the person's user log, the first two also
//   in the space log.
// - A moderation state is the moderated record's `mod` field, so a pull of
//   the record alone serves the redacted form.
// - Space ids are ULIDs. A space's activity (its thread count and the time of
//   its last thread) is a separate `stats` record that only the space's
//   readers get: the space record is public, so it carries nothing that
//   changes when someone posts.
// - A moderated record's text is erased from storage when it is removed; a
//   hidden record keeps its text, and `view` decides who gets it.
// - An ask thread's root ask is the thread itself: nodes, runs and comments
//   name it `r`, and its answer is `answer:<thread>`.
// - Join requests (`request`) are not part of the build (C10), and no mutator
//   of this package writes one. The kind stays in the union so that
//   `@session/replica-proto` keeps its join-request mutators, whose
//   stale-intent rules (approve, decline, reopen) are tested only there
//   (`01` U4), on this package's `Tx`. It is not in the contract's
//   `storedRecordSchema`.
// - Reads go through three indexes (`01` D1, U2): by space (`sp`), by thread
//   (`th`) and by person (`u`), each per kind (`indexOf`); and two unique
//   lookups, a space by its name and a channel invite link by its code
//   (`uniqueOf`).

import type { Spaces } from "@session/shared";

/** A change log: one per space and one per user. */
export type LogId = `space:${string}` | `user:${string}`;

export type SpaceRole = Spaces.SpaceMemberRole;
export type ModState = Spaces.ModerationState;
export type Visibility = Spaces.SpaceVisibility;

export type SpaceRec = Spaces.SpaceRecord;
export type StatsRec = Spaces.StatsRecord;
export type MemberRec = Spaces.MemberRecord;
export type ThreadRec = Spaces.ThreadRecord;
export type CountsRec = Spaces.CountsRecord;
export type NodeRec = Spaces.NodeRecord;
export type RunRec = Spaces.RunRecord;
export type AnswerRec = Spaces.AnswerRecord;
export type ReplyRec = Spaces.ReplyRecord;
export type CommentRec = Spaces.CommentRecord;
export type BanRec = Spaces.BanRecord;
export type InviteRec = Spaces.InviteRecord;
export type SaveRec = Spaces.SaveRecord;
export type NotifRec = Spaces.NotificationRecord;
export type PrefsRec = Spaces.PrefsRecord;
export type ModlogRec = Spaces.ModlogRecord;

/** A join request (prototype only, C10): one per person and space. */
export interface RequestRec {
  kind: "request";
  sp: string;
  u: string;
  st: "open" | "approved" | "declined";
  /** The owner's note to a declined person. */
  why: string | null;
  createdAt: string;
  updatedAt: string;
  rev: number;
}

export type StoredRecord =
  | SpaceRec
  | StatsRec
  | MemberRec
  | ThreadRec
  | CountsRec
  | NodeRec
  | RunRec
  | AnswerRec
  | ReplyRec
  | CommentRec
  | RequestRec
  | BanRec
  | InviteRec
  | SaveRec
  | NotifRec
  | PrefsRec
  | ModlogRec;

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
  "node",
  "reply",
  "comment",
  "run",
  "invite",
  "notif",
  "modlog",
]);

export const spaceKey = (id: string) => `space:${id}`;
export const statsKey = (sp: string) => `stats:${sp}`;
export const memberKey = (sp: string, u: string) => `member:${sp}:${u}`;
export const threadKey = (id: string) => `thread:${id}`;
export const countsKey = (th: string) => `counts:${th}`;
export const nodeKey = (id: string) => `node:${id}`;
export const answerKey = (node: string) => `answer:${node}`;
export const requestKey = (sp: string, u: string) => `request:${sp}:${u}`;
export const banKey = (sp: string, u: string) => `ban:${sp}:${u}`;
export const saveKey = (u: string, th: string) => `save:${u}:${th}`;
export const prefsKey = (u: string) => `prefs:${u}`;

export function keyOf(r: Draft | StoredRecord): string {
  switch (r.kind) {
    case "stats":
      return statsKey(r.sp);
    case "counts":
      return countsKey(r.th);
    case "member":
      return memberKey(r.sp, r.u);
    case "answer":
      return answerKey(r.node);
    case "request":
      return requestKey(r.sp, r.u);
    case "ban":
      return banKey(r.sp, r.u);
    case "save":
      return saveKey(r.u, r.th);
    case "prefs":
      return prefsKey(r.u);
    default:
      return `${r.kind}:${r.id}`;
  }
}

/** The id a record holds in the global id registry, if its kind has one. */
export function idOf(r: Draft | StoredRecord): string | null {
  return ID_KINDS.has(r.kind) && "id" in r ? r.id : null;
}

/** A record's entry in the server's registry: its id for a kind that has
 * one (ids are unique across kinds), else its key. */
export const registryKey = (r: Draft | StoredRecord): string => idOf(r) ?? keyOf(r);

/** The space a record belongs to, or null for a person's own records. */
export function spaceOf(r: Draft | StoredRecord): string | null {
  switch (r.kind) {
    case "space":
      return r.id;
    case "thread":
    case "counts":
    case "node":
    case "reply":
    case "comment":
    case "run":
    case "answer":
      return r.s;
    case "stats":
    case "member":
    case "request":
    case "ban":
    case "invite":
    case "modlog":
      return r.sp;
    case "save":
    case "notif":
    case "prefs":
      return null;
  }
}

/** The person whose user log holds a record, or null. */
export function personOf(r: Draft | StoredRecord): string | null {
  switch (r.kind) {
    case "member":
    case "request":
    case "save":
    case "prefs":
      return r.u;
    case "notif":
      return r.to;
    default:
      return null;
  }
}

/** The logs a record is written to: its space's log, and the user log of the
 * person it belongs to (a membership, a join request, a save, a
 * notification, preferences). */
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

/** A declared lookup (`01` U2): the records of a kind in one space, one
 * thread, or of one person. */
export type Index = { sp: string } | { th: string } | { u: string };

/** The index columns of a record (`01` D1: `sp`, `th`, `u`):
 * - `sp`: its space (`spaceOf`), and for a notification the space it is about;
 * - `th`: the thread it belongs to or is about;
 * - `u`: the person whose user log holds it (`personOf`), else its author or
 *   maker (a run's asker, an invite link's maker, a moderation log entry's
 *   owner). */
export function indexOf(r: Draft | StoredRecord): {
  sp: string | null;
  th: string | null;
  u: string | null;
} {
  const sp = r.kind === "notif" ? r.sp : spaceOf(r);
  const th = r.kind === "thread" ? r.id : "th" in r && typeof r.th === "string" ? r.th : null;
  const u = personOf(r) ?? ("u" in r ? r.u : "by" in r ? r.by : null);
  return { sp, th, u };
}

/** Whether a record is in an index. */
export function inIndex(r: Draft | StoredRecord, index: Index): boolean {
  const cols = indexOf(r);
  if ("sp" in index) return cols.sp === index.sp;
  if ("th" in index) return cols.th === index.th;
  return cols.u === index.u;
}

/** The unique lookups: a space by its name, a channel invite link by its code. */
export type UniqueIndex = "space.name" | "invite.code";

/** The kind each unique lookup finds. */
export type UniqueKind<I extends UniqueIndex> = I extends "space.name" ? "space" : "invite";

/** A record's value in a unique lookup, or null when it is not in it. */
export function uniqueOf(r: Draft | StoredRecord, index: UniqueIndex): string | null {
  if (index === "space.name") return r.kind === "space" ? r.name : null;
  return r.kind === "invite" ? r.code : null;
}

/** The server's creation time of a record (a member record's `joinedAt`), or
 * "" for a record without one. */
export function createdOf(r: StoredRecord): string {
  if ("createdAt" in r) return r.createdAt;
  if (r.kind === "member") return r.joinedAt;
  return "";
}
