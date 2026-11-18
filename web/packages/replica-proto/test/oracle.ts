// The suite's statement of the read rules, written apart from the server's
// own (`src/access.ts`): what a reader may hold of one log, computed from the
// server's stored records. Tests compare snapshots, pulls and replicas with it.
//
//   space log   the space record: everyone
//               members of an open space, and all its threads, follow-ups,
//               replies and runs: everyone, signed out included
//               in a closed space: the same for its members; a non-member
//               gets the threads, follow-ups and runs they wrote
//               reports and join requests: the space's moderators (and up),
//               and the person who made them; bans: the moderators; invite
//               links: the moderators, and the maker while a member
//   user log    that user's memberships, join requests, reports, likes, saves
//               and notifications; nothing for anyone else
//   moderated   a hidden or removed thread, follow-up or reply has its text
//               taken out, for every reader

import type { LogId, StoredRecord } from "../src/index.js";

type Dump = ReadonlyMap<string, StoredRecord>;

const STAFF = new Set(["mod", "admin", "owner"]);

function ownerOf(r: StoredRecord): string | null {
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

function spaceIdOf(r: StoredRecord): string | null {
  switch (r.kind) {
    case "space":
      return r.id;
    case "thread":
    case "followup":
    case "reply":
    case "run":
      return r.s;
    case "member":
    case "report":
    case "request":
    case "ban":
    case "invite":
      return r.sp;
    default:
      return null;
  }
}

/** The text of a moderated item is taken out. */
export function redacted(r: StoredRecord): StoredRecord {
  if (r.kind === "thread" && r.mod) return { ...r, q: "", t: null, sum: null };
  if (r.kind === "followup" && r.mod) return { ...r, q: "", a: null };
  if (r.kind === "reply" && r.mod) return { ...r, t: "" };
  return r;
}

export function roleOf(dump: Dump, sp: string, u: string | null): string | null {
  if (u === null) return null;
  const m = dump.get(`member:${sp}:${u}`);
  return m?.kind === "member" ? m.role : null;
}

/** Whether `reader` may read `r` (before redaction). */
export function mayRead(dump: Dump, r: StoredRecord, reader: string | null): boolean {
  const own = reader !== null && ownerOf(r) === reader;
  const sp = spaceIdOf(r);
  if (sp === null) return own;
  const s = dump.get(`space:${sp}`);
  if (s?.kind !== "space") return false;
  const role = roleOf(dump, sp, reader);
  const reads = s.vis === "open" || role !== null;
  const staff = role !== null && STAFF.has(role);
  switch (r.kind) {
    case "space":
      return true;
    case "member":
      return reads || own;
    case "reply":
      return reads;
    case "thread":
    case "followup":
    case "run":
      return reads || (reader !== null && r.u === reader);
    case "report":
    case "request":
      return staff || own;
    case "ban":
      return staff;
    case "invite":
      return staff || (reader !== null && r.by === reader && role !== null);
    default:
      return false;
  }
}

/** What `reader` may hold of `log` now. */
export function expected(dump: Dump, reader: string | null, log: LogId): Map<string, StoredRecord> {
  const out = new Map<string, StoredRecord>();
  const [kind, id] = log.split(":") as ["space" | "user", string];
  if (kind === "user" && reader !== id) return out;
  for (const [key, r] of dump) {
    const inLog = kind === "user" ? ownerOf(r) === id : spaceIdOf(r) === id;
    if (inLog && mayRead(dump, r, reader)) out.set(key, redacted(r));
  }
  return out;
}

/** A short description of how two key → record maps differ, or null. */
export function diff(
  got: ReadonlyMap<string, StoredRecord>,
  want: ReadonlyMap<string, StoredRecord>,
): string | null {
  const out: string[] = [];
  for (const [k, v] of want) {
    const g = got.get(k);
    if (g === v) continue;
    if (!g) out.push(`missing ${k}`);
    else if (JSON.stringify(g) !== JSON.stringify(v))
      out.push(`differs ${k}: got ${JSON.stringify(g)} want ${JSON.stringify(v)}`);
  }
  for (const k of got.keys())
    if (!want.has(k)) out.push(`extra ${k}: ${JSON.stringify(got.get(k))}`);
  return out.length ? out.slice(0, 5).join("\n") : null;
}
