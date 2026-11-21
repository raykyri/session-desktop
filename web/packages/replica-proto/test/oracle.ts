// The suite's read oracle: what a reader may hold of one log, as a table of
// record kind × the reader's place in the record's space, taken from the
// mock's read rules (`docs/mockups/session-web-spaces-mock-api.js`, section
// 5a, READ_RULES), the owner's decisions of phase 0b and the implementation
// plan (`01` C12, C16, C18; `04` §6). It does not use `src/access.ts`; it
// reads the server's stored records only as facts (who is a member with
// which role, whether a space is private).
//
// A reader's place in a space:
//   anon      signed out
//   outsider  signed in, no member record (a banned person is one)
//   member    a member record with the role "member"
//   owner     the member record with the role "owner"
// A cell says who in that place reads the record:
//   all   everyone in that place
//   own   only the record's person (OWNER below)
//   none  nobody in that place
// A private space is one whose `vis` is "private".

import type { LogId, StoredRecord } from "../src/index.js";

type Dump = ReadonlyMap<string, StoredRecord>;
type Kind = StoredRecord["kind"];
type Place = "anon" | "outsider" | "member" | "owner";
type Cell = "all" | "own" | "none";
type Row = Record<Place, Cell>;

const row = (anon: Cell, outsider: Cell, member: Cell, owner: Cell): Row => ({
  anon,
  outsider,
  member,
  owner,
});
const PUBLIC = row("all", "all", "all", "all");
const MEMBERS = row("none", "none", "all", "all");
const OWN_OR_OWNER = row("none", "own", "own", "all");
const OWNER_ONLY = row("none", "none", "none", "all");
const OWN = row("none", "own", "own", "own");
const OWN_MEMBER = row("none", "none", "own", "own");

/** Who reads a record, by kind, in an open and in a private space. A save is
 * in its thread's space, and a notification in the space it is about; a
 * record with no space uses the `open` row. */
export const READ: Record<Kind, { open: Row; closed: Row }> = {
  // the landing (name, About, owner, member count) is public
  space: { open: PUBLIC, closed: PUBLIC },
  // closedContent: a private space's content is for its members; a
  // non-member gets none of it, their own threads included (owner decision, 0b)
  stats: { open: PUBLIC, closed: MEMBERS },
  thread: { open: PUBLIC, closed: MEMBERS },
  // a thread's save and branch counts are read with the thread (decision 4
  // of review round 1)
  counts: { open: PUBLIC, closed: MEMBERS },
  node: { open: PUBLIC, closed: MEMBERS },
  answer: { open: PUBLIC, closed: MEMBERS },
  reply: { open: PUBLIC, closed: MEMBERS },
  comment: { open: PUBLIC, closed: MEMBERS },
  run: { open: PUBLIC, closed: MEMBERS },
  turn: { open: PUBLIC, closed: MEMBERS },
  // closedMembers: the member list of a private space is for its members; a
  // person reads their own membership
  member: { open: PUBLIC, closed: row("none", "own", "all", "all") },
  // join requests (prototype only) and bans: your own, and all of them for
  // the owner (a banned person is an outsider: `own` in that place); invite
  // links and the moderation log: the owner only (`01` C12, C18)
  request: { open: OWN_OR_OWNER, closed: OWN_OR_OWNER },
  ban: { open: OWN_OR_OWNER, closed: OWN_OR_OWNER },
  invite: { open: OWNER_ONLY, closed: OWNER_ONLY },
  modlog: { open: OWNER_ONLY, closed: OWNER_ONLY },
  // the person's own, and in a private space only while the person may read
  // it (review round 1: user logs follow current access)
  save: { open: OWN, closed: OWN_MEMBER },
  notif: { open: OWN, closed: OWN_MEMBER },
  prefs: { open: OWN, closed: OWN },
};

/** The person a record belongs to, for `own` cells and for user logs. */
const OWNER: Record<Kind, ((r: never) => string) | null> = {
  space: null,
  stats: null,
  thread: null,
  counts: null,
  node: null,
  answer: null,
  reply: null,
  comment: null,
  run: null,
  turn: null,
  ban: (r: { u: string }) => r.u,
  invite: null,
  modlog: null,
  member: (r: { u: string }) => r.u,
  request: (r: { u: string }) => r.u,
  save: (r: { u: string }) => r.u,
  prefs: (r: { u: string }) => r.u,
  notif: (r: { to: string }) => r.to,
};

/** The space a record belongs to. */
const SPACE: Record<Kind, ((r: never) => string) | null> = {
  space: (r: { id: string }) => r.id,
  stats: (r: { sp: string }) => r.sp,
  thread: (r: { s: string }) => r.s,
  counts: (r: { s: string }) => r.s,
  node: (r: { s: string }) => r.s,
  answer: (r: { s: string }) => r.s,
  reply: (r: { s: string }) => r.s,
  comment: (r: { s: string }) => r.s,
  run: (r: { s: string }) => r.s,
  turn: (r: { s: string }) => r.s,
  member: (r: { sp: string }) => r.sp,
  request: (r: { sp: string }) => r.sp,
  ban: (r: { sp: string }) => r.sp,
  invite: (r: { sp: string }) => r.sp,
  modlog: (r: { sp: string }) => r.sp,
  save: null,
  notif: null,
  prefs: null,
};

/** Which logs hold a kind: its space's log, and the user log of its person. */
const IN_SPACE_LOG: ReadonlySet<Kind> = new Set<Kind>([
  "space",
  "stats",
  "thread",
  "counts",
  "node",
  "answer",
  "reply",
  "comment",
  "run",
  "turn",
  "member",
  "request",
  "ban",
  "invite",
  "modlog",
]);
const IN_USER_LOG: ReadonlySet<Kind> = new Set<Kind>([
  "member",
  "request",
  "ban",
  "save",
  "notif",
  "prefs",
]);

/** The text of a moderated item, by state, for its author, the space's owner,
 * and everyone else: "hidden text is served to its author and the space's
 * owner" and "removed: the text is erased". `text` is the stored text,
 * `blank` the placeholder. */
const TEXT: Record<
  "none" | "hidden" | "removed",
  Record<"author" | "owner" | "other", "text" | "blank">
> = {
  none: { author: "text", owner: "text", other: "text" },
  hidden: { author: "text", owner: "text", other: "blank" },
  removed: { author: "blank", owner: "blank", other: "blank" },
};

const ownerOf = (r: StoredRecord) => {
  const f = OWNER[r.kind];
  return f ? (f as (x: StoredRecord) => string)(r) : null;
};
const spaceOfRec = (r: StoredRecord) => {
  const f = SPACE[r.kind];
  return f ? (f as (x: StoredRecord) => string)(r) : null;
};
/** The space whose read rule applies: the record's own; a save's thread's
 * space; a notification's space. */
const ruleSpace = (dump: Dump, r: StoredRecord): string | null => {
  if (r.kind === "save") {
    const p = dump.get(`thread:${r.th}`);
    return p?.kind === "thread" ? p.s : null;
  }
  if (r.kind === "notif") return r.sp;
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
  return role === null ? "outsider" : role === "owner" ? "owner" : "member";
}

export function isClosedSpace(dump: Dump, sp: string): boolean {
  const s = dump.get(`space:${sp}`);
  return s?.kind === "space" && s.vis === "private";
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

/** A record as `reader` gets it: moderated text decided by `TEXT`; a removed
 * thread's author only for the author (`04` §6.2). */
export function shown(dump: Dump, r: StoredRecord, reader: string | null): StoredRecord {
  if (
    r.kind !== "thread" &&
    r.kind !== "node" &&
    r.kind !== "reply" &&
    r.kind !== "comment" &&
    r.kind !== "answer"
  )
    return r;
  const author = reader !== null && r.u === reader;
  const who = author ? "author" : placeOf(dump, r.s, reader) === "owner" ? "owner" : "other";
  if (TEXT[r.mod ?? "none"][who] === "text") return r;
  if (r.kind === "thread")
    return { ...r, q: "", t: null, sum: null, u: r.mod === "removed" && !author ? null : r.u };
  if (r.kind === "node") return { ...r, q: "", look: null, quote: null };
  // a hidden ask's answer is hidden with it
  if (r.kind === "answer") return { ...r, md: "", pages: [] };
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
