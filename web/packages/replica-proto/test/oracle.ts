// The suite's read oracle: what a reader may hold of one log, as a table of
// record kind × the reader's place in the record's space, taken from the
// mock's read rules (`docs/mockups/session-web-spaces-mock-api.js`, section
// 5a, READ_RULES) and the owner's decisions of phase 0b. It does not use
// `src/access.ts`; it reads the server's stored records only as facts (who is
// a member with which role, whether a space is closed).
//
// A reader's place in a space:
//   anon      signed out
//   outsider  signed in, no member record (a banned person is one)
//   member    a member record with the role "member"
//   staff     a member record with the role mod, admin or owner
// A cell says who in that place reads the record:
//   all   everyone in that place
//   own   only the record's person (OWNER below)
//   none  nobody in that place
// A closed space is one whose `vis` is listed or unlisted.

import type { LogId, StoredRecord } from "../src/index.js";
import { USE_PACKAGE } from "../src/switch.js";

type Dump = ReadonlyMap<string, StoredRecord>;
/** The prototype's kinds, and `hide`: with the switch on, `@session/mutators`
 * keeps a hidden item's state in a hide record keyed by the item (phase 1b,
 * Part 0 item 3), read with the space's content. */
type Kind = StoredRecord["kind"] | "hide" | "exit";
type Place = "anon" | "outsider" | "member" | "staff";
type Cell = "all" | "own" | "none";
type Row = Record<Place, Cell>;

const row = (anon: Cell, outsider: Cell, member: Cell, staff: Cell): Row => ({
  anon,
  outsider,
  member,
  staff,
});
const PUBLIC = row("all", "all", "all", "all");
const MEMBERS = row("none", "none", "all", "all");
const OWN_OR_STAFF = row("none", "own", "own", "all");
const STAFF = row("none", "none", "none", "all");
const OWN = row("none", "own", "own", "own");
const OWN_STAFF = row("none", "none", "none", "own");

/** Who reads a record, by kind, in an open and in a closed space. A like or
 * a save is in its thread's space, and a notification in the space it is
 * about; a record with no space uses the `open` row. */
export const READ: Record<Kind, { open: Row; closed: Row }> = {
  // the landing and the staff list are public (mock: "Space records are public")
  space: { open: PUBLIC, closed: PUBLIC },
  // closedContent: a closed space's content is for its members; a non-member
  // gets none of it, their own threads included (owner decision, 0b)
  stats: { open: PUBLIC, closed: MEMBERS },
  thread: { open: PUBLIC, closed: MEMBERS },
  // a thread's like and follow-up counts are read with the thread (decision
  // 4 of review round 1)
  counts: { open: PUBLIC, closed: MEMBERS },
  followup: { open: PUBLIC, closed: MEMBERS },
  reply: { open: PUBLIC, closed: MEMBERS },
  run: { open: PUBLIC, closed: MEMBERS },
  hide: { open: PUBLIC, closed: MEMBERS },
  // closedMembers: the member list of a closed space is for its members (the
  // staff list is on the space record); a person reads their own membership
  member: { open: PUBLIC, closed: row("none", "own", "all", "all") },
  // ownOrModerated: requests and reports, your own and those of the spaces
  // you moderate; bans, the spaces you moderate; invite links, the spaces you
  // moderate and the links you made while you are a member
  request: { open: OWN_OR_STAFF, closed: OWN_OR_STAFF },
  // a report follows its person's access, as a like does: in a closed space
  // their own only while they are a member (review round 1 of phase 1, W6)
  report: {
    open: OWN_OR_STAFF,
    closed: USE_PACKAGE ? row("none", "none", "own", "all") : OWN_OR_STAFF,
  },
  ban: { open: STAFF, closed: STAFF },
  invite: { open: row("none", "none", "own", "all"), closed: row("none", "none", "own", "all") },
  // the mock's /api/me collections: the person's own, and in a closed space
  // only while the person may read it (review round 1: user logs follow
  // current access)
  like: { open: OWN, closed: row("none", "none", "own", "own") },
  save: { open: OWN, closed: row("none", "none", "own", "own") },
  // a report's notification: like the report, for the space's staff; the
  // person's own while they are staff of the space (review round 2, decision 4)
  notif: { open: OWN_STAFF, closed: OWN_STAFF },
  // with the switch on: how a membership ended, the person's only, whatever
  // their access (review round 1 of phase 1)
  exit: { open: OWN, closed: OWN },
};

/** The person a record belongs to, for `own` cells and for user logs. */
const OWNER: Record<Kind, ((r: never) => string) | null> = {
  space: null,
  stats: null,
  thread: null,
  counts: null,
  followup: null,
  reply: null,
  run: null,
  hide: null,
  exit: (r: { u: string }) => r.u,
  ban: null,
  member: (r: { u: string }) => r.u,
  request: (r: { u: string }) => r.u,
  like: (r: { u: string }) => r.u,
  save: (r: { u: string }) => r.u,
  report: (r: { by: string }) => r.by,
  invite: (r: { by: string }) => r.by,
  notif: (r: { to: string }) => r.to,
};

/** The space a record belongs to. */
const SPACE: Record<Kind, ((r: never) => string) | null> = {
  space: (r: { id: string }) => r.id,
  stats: (r: { sp: string }) => r.sp,
  thread: (r: { s: string }) => r.s,
  counts: (r: { s: string }) => r.s,
  followup: (r: { s: string }) => r.s,
  reply: (r: { s: string }) => r.s,
  run: (r: { s: string }) => r.s,
  hide: (r: { s: string }) => r.s,
  exit: null,
  member: (r: { sp: string }) => r.sp,
  request: (r: { sp: string }) => r.sp,
  report: (r: { sp: string }) => r.sp,
  ban: (r: { sp: string }) => r.sp,
  invite: (r: { sp: string }) => r.sp,
  like: null,
  save: null,
  notif: null,
};

/** Which logs hold a kind: its space's log, and the user log of its person. */
const IN_SPACE_LOG: ReadonlySet<Kind> = new Set<Kind>([
  "space",
  "stats",
  "thread",
  "counts",
  "followup",
  "reply",
  "run",
  "hide",
  "member",
  "request",
  "report",
  "ban",
  "invite",
]);
const IN_USER_LOG: ReadonlySet<Kind> = new Set<Kind>([
  "member",
  "request",
  "report",
  "like",
  "save",
  "notif",
  "exit",
]);

/** The text of a moderated item, by state, for its author, the space's
 * staff, and everyone else: the owner's decision of 0b ("hidden text is
 * served to its author and to the space's moderators") and "removed: the text
 * is erased". `text` is the stored text, `blank` the placeholder. */
const TEXT: Record<
  "none" | "hidden" | "removed",
  Record<"author" | "staff" | "other", "text" | "blank">
> = {
  none: { author: "text", staff: "text", other: "text" },
  hidden: { author: "text", staff: "text", other: "blank" },
  removed: { author: "blank", staff: "blank", other: "blank" },
};

/** An item's moderation state: its own `mod` (the prototype's, and a
 * package item's "removed"), or "hidden" when a hide record names it. */
export function modOf(
  dump: Dump,
  r: { kind: string; id: string; mod: string | null },
): "hidden" | "removed" | null {
  if (r.mod === "removed" || r.mod === "hidden") return r.mod;
  return dump.has(`hide:${r.kind}:${r.id}`) ? "hidden" : null;
}

/** The rev a "shown" (or a reopening that shows) compares: the item's own
 * rev in the prototype, the hide record's with the switch on. */
export function showRev(dump: Dump, itemKey: string): number {
  if (!USE_PACKAGE) return dump.get(itemKey)?.rev ?? 0;
  return dump.get(`hide:${itemKey}`)?.rev ?? 0;
}

const ownerOf = (r: StoredRecord) => {
  const f = OWNER[r.kind];
  return f ? (f as (x: StoredRecord) => string)(r) : null;
};
const spaceOfRec = (r: StoredRecord) => {
  const f = SPACE[r.kind];
  return f ? (f as (x: StoredRecord) => string)(r) : null;
};
/** The space whose read rule applies: the record's own; a like's or a save's
 * thread's space; a notification's space. */
const ruleSpace = (dump: Dump, r: StoredRecord): string | null => {
  if (r.kind === "like" || r.kind === "save") {
    const p = dump.get(`thread:${r.th}`);
    return p?.kind === "thread" ? p.s : null;
  }
  if (r.kind === "notif") return r.sp;
  if ((r.kind as Kind) === "exit") return (r as unknown as { sp: string }).sp;
  return spaceOfRec(r);
};

export function roleOf(dump: Dump, sp: string, u: string | null): string | null {
  if (u === null) return null;
  const m = dump.get(`member:${sp}:${u}`);
  return m?.kind === "member" ? m.role : null;
}

export function placeOf(dump: Dump, sp: string, u: string | null): Place {
  if (u === null) return "anon";
  const role = roleOf(dump, sp, u);
  return role === null ? "outsider" : role === "member" ? "member" : "staff";
}

export function isClosedSpace(dump: Dump, sp: string): boolean {
  const s = dump.get(`space:${sp}`);
  return s?.kind === "space" && s.vis !== "open";
}

/** Whether `reader` may read `r` (before its text is decided). */
export function mayRead(dump: Dump, r: StoredRecord, reader: string | null): boolean {
  const sp = ruleSpace(dump, r);
  if (sp !== null && dump.get(`space:${sp}`)?.kind !== "space") return false;
  const rule = READ[r.kind][sp !== null && isClosedSpace(dump, sp) ? "closed" : "open"];
  const cell =
    rule[sp === null ? (reader === null ? "anon" : "outsider") : placeOf(dump, sp, reader)];
  return cell === "all" || (cell === "own" && reader !== null && ownerOf(r) === reader);
}

/** A record as `reader` gets it: moderated text decided by `TEXT`. */
export function shown(dump: Dump, r: StoredRecord, reader: string | null): StoredRecord {
  if (r.kind !== "thread" && r.kind !== "followup" && r.kind !== "reply") return r;
  const who =
    reader !== null && r.u === reader
      ? "author"
      : placeOf(dump, r.s, reader) === "staff"
        ? "staff"
        : "other";
  if (TEXT[modOf(dump, r) ?? "none"][who] === "text") return r;
  if (r.kind === "thread") return { ...r, q: "", t: null, sum: null };
  if (r.kind === "followup") return { ...r, q: "", a: null };
  return { ...r, t: "" };
}

/** What `reader` may hold of `log` now. */
export function expected(dump: Dump, reader: string | null, log: LogId): Map<string, StoredRecord> {
  const out = new Map<string, StoredRecord>();
  const [kind, id] = log.split(":") as ["space" | "user", string];
  if (kind === "user" && (reader === null || reader !== id)) return out;
  for (const [key, r] of dump) {
    const inLog =
      kind === "user"
        ? IN_USER_LOG.has(r.kind) && ownerOf(r) === id
        : IN_SPACE_LOG.has(r.kind) && spaceOfRec(r) === id;
    if (inLog && mayRead(dump, r, reader)) out.set(key, shown(dump, r, reader));
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
