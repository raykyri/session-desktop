// The suite's write oracle: a reference model of the server's answer to one
// envelope, written apart from `src/mutators.ts`, `src/access.ts` and
// `src/server.ts`. It predicts ok or the refusal's code, and whether the
// answer is recorded, from:
// - the rules below, taken from the mock's PROCS and `who` checks
//   (`docs/mockups/session-web-spaces-mock-api.js`, sections 5a and 5b), the
//   decided rules in AGENTS.md, the owner's decisions of phase 0b and the
//   implementation plan (`01` C1-C18: one owner per space, no likes, rules or
//   reporting, nodes and comments);
// - the server's stored records, read as facts (who has which role, which
//   ids exist), and the read oracle (`oracle.ts`) for "may the actor read the
//   target";
// - its own model of the protocol state: registered clients and their last
//   seq, and the idempotency table.
//
// When a write has more than one fault, the first check in the mock's order
// decides: the role (`who`) and `can` first (its `authorize`), then `run` in
// the order its statements read the state; a new record's id is checked
// where the record is written, after the rules that refuse it. For a write
// predicted `ok`, `effect-model.ts` predicts what it changes.
//
// The protocol, in order (the first that applies decides):
//   0. an input nested more than 32 deep: BAD_REQUEST; an envelope larger
//      than 256 KB as JSON: TOO_LARGE (round 2, decision 8; `01` Y1)
//                                                              unrecorded
//   1. protocolVersion an integer below 4: UPGRADE_REQUIRED    unrecorded
//   2. envelope: exactly { clientId, seq ≥ 1, mutationId, name, input,
//      protocolVersion, clientTime ≥ 0, queuedAt ≥ 0 } and optionally
//      `replaces` (at most 16 ULIDs), else BAD_REQUEST          unrecorded
//   3. signed out, or a handle no person may have: UNAUTHORIZED unrecorded
//   4. the client id unknown, another user's, or not used for 90 days:
//      WRONG_CLIENT                                            unrecorded
//   5. a stored answer for (user, mutation id) with the same name and input
//      (key order aside), or stored under that id by an envelope that
//      replaced it, within 7 days: that answer, under any client id or seq
//      of the user                                             unrecorded
//   6. an answer stored for (client, seq) with the same mutation id, name
//      and input, within 7 days: that answer                   unrecorded
//   7. seq not the client's last + 1: OUT_OF_ORDER             unrecorded
//   8. a mutation id that is not a ULID, or one stored with another payload:
//      BAD_REQUEST                      uses the seq, stored for (client, seq)
//   9. clientTime more than a minute from the server's time: CLOCK_SKEW
//      (round 2, decision 3: only the device's clock against the server's)
//                                                              unrecorded
//  10. the mutation id's age on the device (clientTime − its time) above 4
//      days or below −1 minute: EXPIRED; then the same for queuedAt
//                                                              stored
//  11. an unknown name: NOT_FOUND; 12. an input outside the schema:
//      BAD_REQUEST                                             stored
//  13. a new id in the input with such an age: EXPIRED         stored
//  14. an online-only write (spaces.create) whose mutation id is over a
//      minute old on the device: EXPIRED (it waited in an outbox) stored
//  15. the mutator's own rules (RULES below)                   stored
// "Stored" answers use the seq and are kept for replays for 7 days, under
// (user, mutation id) and under each id in `replaces` that has no answer.
// An answer that uses the seq is always stored (round 1, R7b). INTERNAL_SERVER_ERROR (the server's random source failed, in the
// invite code's pre-check) is unrecorded.
//
// Registration (round 2, decision 5): UNAUTHORIZED for a signed-out caller
// or a reserved handle, TOO_MANY_REQUESTS for a person who registered 20
// clients in the past day, INTERNAL_SERVER_ERROR when the random source
// fails.

import type { Envelope, ErrorCode, StoredRecord } from "../src/index.js";

import { slug } from "./effect-model.js";
import { mayRead } from "./oracle.js";

type Dump = ReadonlyMap<string, StoredRecord>;
export type Code = "ok" | ErrorCode;
export interface Prediction {
  code: Code;
  /** The seq is used up (the client's last seq becomes this one). */
  usesSeq: boolean;
  /** The answer is kept for replays of (user, mutation id). */
  stored: boolean;
  /** The answer is kept for replays of (client, seq) instead. */
  storedForSeq?: boolean;
}

const MIN_DAY = 86_400_000;
const MINUTE_MS = 60_000;
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const HANDLE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const RESERVED = ["null", "undefined"];

const isHandle = (u: unknown) => typeof u === "string" && HANDLE.test(u) && !RESERVED.includes(u);
const timeOf = (id: string) => [...id.slice(0, 10)].reduce((t, ch) => t * 32 + B32.indexOf(ch), 0);
/** A time's age on the device's clock is from −1 minute to 4 days. */
const freshTime = (ms: number, deviceNow: number) => {
  const age = deviceNow - ms;
  return age >= -MINUTE_MS && age <= 4 * MIN_DAY;
};
/** An id's age on the device's clock is from −1 minute to 4 days. */
const fresh = (id: string, deviceNow: number) => freshTime(timeOf(id), deviceNow);
/** How deep a value nests (a scalar 0, `[1]` 1), walked without recursion;
 * Infinity past 10,000 levels or 300,000 values. */
function depthOf(v: unknown): number {
  let deepest = 0;
  let seen = 0;
  const todo: [unknown, number][] = [[v, 0]];
  for (let x = todo.pop(); x; x = todo.pop()) {
    if (++seen > 300_000) return Infinity;
    const [value, level] = x;
    if (value === null || typeof value !== "object") continue;
    deepest = Math.max(deepest, level + 1);
    if (deepest > 10_000) return Infinity;
    for (const y of Object.values(value)) todo.push([y, level + 1]);
  }
  return deepest;
}
function sortedJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(sortedJson).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.entries(v)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, x]) => `${JSON.stringify(k)}:${sortedJson(x)}`)
      .join(",")}}`;
  return String(JSON.stringify(v));
}

// ---- input schemas (strict: no other field) ----

type Check = (v: unknown) => boolean;
const str: Check = (v) => typeof v === "string";
/** A string of at most `n` characters (UTF-16 units, as zod counts). */
const upTo =
  (n: number): Check =>
  (v) =>
    typeof v === "string" && v.length <= n;
const bool: Check = (v) => typeof v === "boolean";
const ulid: Check = (v) => typeof v === "string" && ULID.test(v);
const nat: Check = (v) => typeof v === "number" && Number.isInteger(v) && v >= 0;
const oneOf =
  (...xs: unknown[]): Check =>
  (v) =>
    xs.includes(v);
const handle: Check = isHandle;
const itemKey: Check = (v) =>
  typeof v === "string" && /^[a-z]+:[0-9A-HJKMNP-TV-Z]{26}(:.*)?$/.test(v);
/** `r` (a thread's root ask) or a node's id. */
const nodeRef: Check = (v) => v === "r" || ulid(v);
const model: Check = (v) => typeof v === "string" && v.length >= 1 && v.length <= 100;
const effort = oneOf("low", "medium", "high", "xhigh", "max");
const obj =
  (req: Record<string, Check>, opt: Record<string, Check> = {}): Check =>
  (v) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return false;
    const o = v as Record<string, unknown>;
    for (const k of Object.keys(o)) if (!(k in req) && !(k in opt)) return false;
    for (const [k, c] of Object.entries(req)) if (!(k in o) || !c(o[k])) return false;
    for (const [k, c] of Object.entries(opt))
      if (k in o && o[k] !== undefined && !c(o[k])) return false;
    return true;
  };
/** An input whose shape depends on its `kind`. */
const byKind =
  (shapes: Record<string, Check>): Check =>
  (v) => {
    const k = (v as { kind?: unknown } | null)?.kind;
    return typeof k === "string" && Object.hasOwn(shapes, k) && (shapes[k] as Check)(v);
  };
const vis = oneOf("open", "private");
/** `base` of a write on another record: that record's rev as the client saw it. */
const rev = obj({ rev: nat });
/** `base` of joinRequests.decide: one rev for each person in `users`, by handle. */
const revsFor =
  (input: unknown): Check =>
  (v) => {
    const users = (input as { users?: unknown } | null)?.users;
    if (!v || typeof v !== "object" || Array.isArray(v) || !Array.isArray(users)) return false;
    const keys = Object.keys(v);
    return (
      keys.every((k) => isHandle(k) && nat((v as Record<string, unknown>)[k])) &&
      keys.length === new Set(users).size &&
      users.every((u) => keys.includes(String(u)))
    );
  };
const title = (v: unknown) => v === null || str(v);

const SCHEMA: Record<string, Check> = {
  "spaces.create": obj(
    { id: ulid, name: (v) => str(v) && (v as string).length >= 1 && (v as string).length <= 64 },
    { vis, desc: upTo(300) },
  ),
  "spaces.update": obj({ id: ulid, desc: upTo(300) }),
  "spaces.join": obj({ space: ulid }, { invite: upTo(64) }),
  "spaces.leave": obj({ space: ulid }),
  "threads.create": byKind({
    ask: obj({ id: ulid, space: ulid, kind: str, q: upTo(8000), model, effort }, { title }),
    post: obj({ id: ulid, space: ulid, kind: str, q: upTo(8000) }, { title }),
  }),
  "threads.update": obj({ id: ulid, q: upTo(8000), base: obj({ rev: nat }) }),
  "threads.delete": obj({ id: ulid }),
  "saved.set": obj({ kind: oneOf("thread"), id: ulid, on: bool }),
  "research.forkNode": byKind({
    ask: obj(
      { id: ulid, thread: ulid, parent: nodeRef, kind: str, q: upTo(8000), model, effort },
      { quote: upTo(2000), b: nat },
    ),
    lookup: obj(
      { id: ulid, thread: ulid, parent: nodeRef, kind: str, look: upTo(80), model, effort },
      { quote: upTo(2000), b: nat },
    ),
  }),
  "research.createPostFollowUp": obj({ id: ulid, thread: ulid, t: upTo(8000) }, { parent: ulid }),
  "comments.create": obj(
    { id: ulid, thread: ulid, node: nodeRef, t: upTo(8000) },
    { parent: ulid },
  ),
  "joinRequests.create": obj({ space: ulid }),
  "joinRequests.decide": (v) =>
    obj(
      {
        space: ulid,
        users: (x) => Array.isArray(x) && x.length > 0 && x.every(handle),
        decision: oneOf("approve", "decline", "reopen"),
        base: revsFor(v),
      },
      { why: upTo(300) },
    )(v),
  "members.remove": obj({ space: ulid, user: handle, base: obj({ adm: upTo(64) }) }),
  "members.ban": obj({ space: ulid, user: handle }),
  "members.unban": obj({ space: ulid, user: handle }),
  "invites.create": obj({
    id: ulid,
    space: ulid,
    days: (v) => nat(v) && (v as number) >= 1 && (v as number) <= 30,
  }),
  "moderation.decide": obj(
    { item: itemKey, decision: oneOf("hidden", "removed", "shown") },
    { note: upTo(300), base: rev },
  ),
  "notifications.markRead": obj({ id: ulid }),
  "prefs.set": obj({ layout: oneOf("centred", "wide") }),
};

/** The input fields that carry a new client-made id. */
const NEW_IDS: Record<string, string[]> = {
  "spaces.create": ["id"],
  "threads.create": ["id"],
  "research.forkNode": ["id"],
  "research.createPostFollowUp": ["id"],
  "comments.create": ["id"],
  "invites.create": ["id"],
};

// ---- the mutators' rules ----

type In = Record<string, unknown>;
interface Facts {
  dump: Dump;
  me: string;
  /** The server's time, truncated to the second as stored times are. */
  nowSec: number;
  idTaken(id: string): boolean;
  /** The server's random source fails now. */
  randomDown: boolean;
}

/** Thrown with the code a rule refuses with. */
class No extends Error {
  constructor(readonly code: ErrorCode) {
    super(code);
  }
}
const no = (code: ErrorCode): never => {
  throw new No(code);
};

type Space = Extract<StoredRecord, { kind: "space" }>;
type Thread = Extract<StoredRecord, { kind: "thread" }>;
type AskNode = Extract<StoredRecord, { kind: "node" }>;

const spaceAt = (f: Facts, sp: string) => {
  const s = f.dump.get(`space:${sp}`);
  return s?.kind === "space" ? s : undefined;
};
const closed = (s: Space) => s.vis === "private";
const roleOf = (f: Facts, sp: string, u: string): string | null => {
  const m = f.dump.get(`member:${sp}:${u}`);
  return m?.kind === "member" ? m.role : null;
};
const banned = (f: Facts, sp: string, u: string) => f.dump.has(`ban:${sp}:${u}`);
const baseRev = (i: In) => (i["base"] as { rev: number } | undefined)?.rev;
const blank = (v: unknown) => String(v).trim() === "";
/** The space's record, or NOT_FOUND; then: a banned actor is refused every
 * write there; then the role `need` (0: any signed-in person; "member": a
 * member of a private space, anyone in an open one; "owner": the owner). */
function inSpace(f: Facts, sp: string, need: 0 | "member" | "owner"): Space {
  const s = spaceAt(f, sp) ?? no("NOT_FOUND");
  if (banned(f, sp, f.me)) no("FORBIDDEN");
  if (need === "member" && closed(s) && roleOf(f, sp, f.me) === null) no("FORBIDDEN");
  if (need === "owner" && roleOf(f, sp, f.me) !== "owner") no("FORBIDDEN");
  return s;
}

/** A thread the actor may read, or NOT_FOUND (one answer for both). */
function seenThread(f: Facts, id: unknown): Thread {
  const p = f.dump.get(`thread:${String(id)}`);
  if (p?.kind !== "thread" || !mayRead(f.dump, p, f.me)) no("NOT_FOUND");
  return p as Thread;
}

/** The node a reference names in a thread the actor reads: the thread for
 * `r`, else a node of that thread the actor may read, or NOT_FOUND. */
function seenNode(f: Facts, p: Thread, ref: unknown): Thread | AskNode {
  if (ref === "r") return p;
  const n = f.dump.get(`node:${String(ref)}`);
  if (n?.kind !== "node" || n.th !== p.id || !mayRead(f.dump, n, f.me)) no("NOT_FOUND");
  return n as AskNode;
}

/** The item a moderation key names, if the actor may read it. */
function seenItem(f: Facts, key: string) {
  const parts = key.split(":");
  const [k, th, sub] = parts;
  if (parts.length > 3 || !th) no("NOT_FOUND");
  if ((k === "a" || k === "p") && parts.length === 2) {
    const p = seenThread(f, th);
    if ((p.k === "ask") !== (k === "a")) no("NOT_FOUND");
    return p;
  }
  const want = k === "f" ? "node" : k === "r" ? "reply" : k === "c" ? "comment" : null;
  if (want && sub) {
    const r = f.dump.get(`${want}:${sub}`);
    if (!r || r.kind !== want || r.th !== th || !mayRead(f.dump, r, f.me)) no("NOT_FOUND");
    return r as Extract<StoredRecord, { kind: "node" | "reply" | "comment" }>;
  }
  return no("NOT_FOUND");
}

/** A look-up phrase is 1 to 4 words, once what is not a letter or a digit is
 * taken off both ends (`03` G2). */
function phraseOk(v: string): boolean {
  const chars = [...v];
  const word = (ch: string) => /[\p{L}\p{N}]/u.test(ch);
  while (chars.length && !word(chars[0] as string)) chars.shift();
  while (chars.length && !word(chars[chars.length - 1] as string)) chars.pop();
  const n = chars
    .join("")
    .split(/\s+/)
    .filter((x) => x !== "").length;
  return n >= 1 && n <= 4;
}

const RULES: Record<string, (f: Facts, i: In) => void> = {
  "spaces.create": (f, i) => {
    const name = slug(String(i["name"]));
    if (!name) no("BAD_REQUEST");
    for (const r of f.dump.values()) if (r.kind === "space" && r.name === name) no("CONFLICT");
    if (f.idTaken(String(i["id"]))) no("CONFLICT");
  },
  // About only, by the owner (`01` C11)
  "spaces.update": (f, i) => {
    inSpace(f, String(i["id"]), "owner");
  },
  "spaces.join": (f, i) => {
    const s = inSpace(f, String(i["space"]), 0);
    if (roleOf(f, s.id, f.me) !== null || !closed(s)) return;
    const code = i["invite"];
    if (code === undefined) no("FORBIDDEN");
    const link = [...f.dump.values()].find((r) => r.kind === "invite" && r.code === code);
    const live =
      link?.kind === "invite" &&
      link.sp === s.id &&
      link.dead === null &&
      Date.parse(link.expiresAt) > f.nowSec;
    if (!live) no("FORBIDDEN");
  },
  // the owner cannot leave (`01` C18)
  "spaces.leave": (f, i) => {
    const sp = String(i["space"]);
    inSpace(f, sp, "member");
    if (roleOf(f, sp, f.me) === "owner") no("PRECONDITION_FAILED");
  },
  "threads.create": (f, i) => {
    inSpace(f, String(i["space"]), "member");
    if (blank(i["q"])) no("BAD_REQUEST");
    if (f.idTaken(String(i["id"]))) no("CONFLICT");
  },
  "threads.update": (f, i) => {
    const p = seenThread(f, i["id"]);
    inSpace(f, p.s, 0);
    if (p.u !== f.me) no("FORBIDDEN");
    if (p.mod === "removed" || p.del || p.gone) no("PRECONDITION_FAILED");
    if (p.rev !== baseRev(i)) no("STALE");
    if (blank(i["q"])) no("BAD_REQUEST");
  },
  "threads.delete": (f, i) => {
    const p = f.dump.get(`thread:${String(i["id"])}`);
    if (p?.kind !== "thread") return no("NOT_FOUND");
    // the author deletes without read access (a removed member's own threads)
    if (p.u !== f.me) seenThread(f, p.id);
    inSpace(f, p.s, 0);
    if (p.u !== f.me) no("FORBIDDEN");
  },
  "saved.set": (f, i) => {
    const mine = f.dump.has(`save:${f.me}:${String(i["id"])}`);
    if (i["on"] === false) {
      const p = f.dump.get(`thread:${String(i["id"])}`);
      if (mine && p?.kind === "thread") inSpace(f, p.s, 0);
      return;
    }
    const p = seenThread(f, i["id"]);
    inSpace(f, p.s, 0);
    if (!mine && p.mod === "removed") no("PRECONDITION_FAILED");
  },
  "research.forkNode": (f, i) => {
    const p = seenThread(f, i["thread"]);
    inSpace(f, p.s, "member");
    if (p.k !== "ask") no("BAD_REQUEST");
    if (p.mod === "removed") no("PRECONDITION_FAILED");
    if (seenNode(f, p, i["parent"]).mod === "removed") no("PRECONDITION_FAILED");
    if (i["kind"] === "ask" ? blank(i["q"]) : !phraseOk(String(i["look"]))) no("BAD_REQUEST");
    if (f.idTaken(String(i["id"]))) no("CONFLICT");
  },
  "research.createPostFollowUp": (f, i) => {
    const p = seenThread(f, i["thread"]);
    inSpace(f, p.s, "member");
    if (p.k !== "post") no("BAD_REQUEST");
    if (p.mod === "removed") no("PRECONDITION_FAILED");
    if (i["parent"] !== undefined) {
      const top = f.dump.get(`reply:${i["parent"] as string}`);
      if (
        top?.kind !== "reply" ||
        !mayRead(f.dump, top, f.me) ||
        top.th !== p.id ||
        top.parent !== null
      )
        no("NOT_FOUND");
      if ((top as Extract<StoredRecord, { kind: "reply" }>).mod === "removed")
        no("PRECONDITION_FAILED");
    }
    if (blank(i["t"])) no("BAD_REQUEST");
    if (f.idTaken(String(i["id"]))) no("CONFLICT");
  },
  // a comment hangs under a node, or under a top-level comment on it (`01` C4)
  "comments.create": (f, i) => {
    const p = seenThread(f, i["thread"]);
    inSpace(f, p.s, "member");
    if (p.k !== "ask") no("BAD_REQUEST");
    if (p.mod === "removed") no("PRECONDITION_FAILED");
    if (seenNode(f, p, i["node"]).mod === "removed") no("PRECONDITION_FAILED");
    if (i["parent"] !== undefined) {
      const top = f.dump.get(`comment:${i["parent"] as string}`);
      if (
        top?.kind !== "comment" ||
        !mayRead(f.dump, top, f.me) ||
        top.th !== p.id ||
        top.node !== i["node"] ||
        top.parent !== null
      )
        no("NOT_FOUND");
      if ((top as Extract<StoredRecord, { kind: "comment" }>).mod === "removed")
        no("PRECONDITION_FAILED");
    }
    if (blank(i["t"])) no("BAD_REQUEST");
    if (f.idTaken(String(i["id"]))) no("CONFLICT");
  },
  "joinRequests.create": (f, i) => {
    const s = inSpace(f, String(i["space"]), 0);
    if (!closed(s) || roleOf(f, s.id, f.me) !== null) no("PRECONDITION_FAILED");
  },
  "joinRequests.decide": (f, i) => {
    const sp = String(i["space"]);
    inSpace(f, sp, "owner");
    const from = i["decision"] === "reopen" ? "declined" : "open";
    const base = i["base"] as Record<string, number>;
    for (const u of new Set(i["users"] as string[])) {
      const r = f.dump.get(`request:${sp}:${u}`);
      if (r?.kind !== "request") no("NOT_FOUND");
      // decided by version (round 1) when the decision could admit someone;
      // a decline restricts and takes the request as it is (round 2)
      if (i["decision"] !== "decline" && (r as StoredRecord).rev !== base[u]) no("STALE");
      if ((r as Extract<StoredRecord, { kind: "request" }>).st !== from) no("PRECONDITION_FAILED");
      if (i["decision"] === "approve" && banned(f, sp, u)) no("PRECONDITION_FAILED");
    }
  },
  // the owner acts on anyone but themselves (`01` C18)
  "members.remove": (f, i) => {
    inSpace(f, String(i["space"]), "owner");
    if (i["user"] === f.me) no("FORBIDDEN");
    // round 2: the admission id the owner saw; nothing to do for a person who
    // is no longer a member
    const m = f.dump.get(`member:${String(i["space"])}:${String(i["user"])}`);
    if (m?.kind === "member" && m.adm !== (i["base"] as { adm: string }).adm) no("STALE");
  },
  // round 2: a ban takes the person as they are, and has no base
  "members.ban": (f, i) => {
    inSpace(f, String(i["space"]), "owner");
    if (i["user"] === f.me) no("FORBIDDEN");
  },
  "members.unban": (f, i) => {
    inSpace(f, String(i["space"]), "owner");
  },
  "invites.create": (f, i) => {
    inSpace(f, String(i["space"]), "owner");
    // the code comes from the server's random source, before the record is written
    if (f.randomDown) no("INTERNAL_SERVER_ERROR");
    if (f.idTaken(String(i["id"]))) no("CONFLICT");
  },
  "moderation.decide": (f, i) => {
    const item = seenItem(f, String(i["item"]));
    inSpace(f, item.s, "owner");
    const d = i["decision"];
    if (d === "shown" && i["base"] === undefined) no("BAD_REQUEST");
    // round 2: only "shown" could expose text, so only it compares the rev
    if (d === "shown" && item.rev !== baseRev(i)) no("STALE");
    if (item.mod === "removed") no("PRECONDITION_FAILED");
    if (d === "hidden" && item.mod !== null) no("PRECONDITION_FAILED");
    if (d === "shown" && item.mod !== "hidden") no("PRECONDITION_FAILED");
  },
  // your own notification, while you may read its space
  "notifications.markRead": (f, i) => {
    const n = f.dump.get(`notif:${String(i["id"])}`);
    if (n?.kind !== "notif" || n.to !== f.me || !mayRead(f.dump, n, f.me)) return no("NOT_FOUND");
    if (n.sp !== null) inSpace(f, n.sp, 0);
  },
  "prefs.set": () => {},
};

const ENVELOPE_KEYS = [
  "clientId",
  "clientTime",
  "input",
  "mutationId",
  "name",
  "protocolVersion",
  "queuedAt",
  "seq",
];
/** The digest of an answer stored under a replaced mutation id. */
const REPLACED = "*";
/** Clients unused this long are gone (round 2, decision 5). */
const CLIENT_IDLE = 90 * MIN_DAY;

interface ClientModel {
  u: string;
  last: number;
  seen: number;
  bySeq: Map<number, { sent: string; code: Code; at: number }>;
}

export class WriteModel {
  private readonly clients = new Map<string, ClientModel>();
  private readonly answers = new Map<string, { payload: string; code: Code; at: number }>();
  /** Every id a stored record ever had. */
  private readonly ids = new Set<string>();
  /** Each person's registrations. */
  private readonly registrations = new Map<string, number[]>();
  /** The server's random source fails now (the suite sets it). */
  randomDown = false;

  /** The client record, or undefined when there is none or it was idle for
   * 90 days (then it is gone for good). */
  private client(clientId: string, now: number): ClientModel | undefined {
    const c = this.clients.get(clientId);
    if (c && c.seen <= now - CLIENT_IDLE) {
      this.clients.delete(clientId);
      return undefined;
    }
    return c;
  }

  /** The answer `register` gives `u` now: ok, or the refusal's code. */
  predictRegister(u: string | null, now: number): Code {
    if (u === null || !isHandle(u)) return "UNAUTHORIZED";
    const recent = (this.registrations.get(u) ?? []).filter((at) => at > now - MIN_DAY);
    if (recent.length >= 20) return "TOO_MANY_REQUESTS";
    if (this.randomDown) return "INTERNAL_SERVER_ERROR";
    return "ok";
  }

  /** A client id the server registered for `u` now. */
  registered(clientId: string, u: string, now = 0) {
    this.clients.set(clientId, { u, last: 0, seen: now, bySeq: new Map() });
    this.registrations.set(u, [...(this.registrations.get(u) ?? []), now]);
  }

  /** A read by `u` named `clientId`: a live client of `u`'s counts as used. */
  read(u: string | null, clientId: string | undefined, now: number) {
    if (u === null || !isHandle(u) || clientId === undefined) return;
    const c = this.client(clientId, now);
    if (c && c.u === u) c.seen = now;
  }

  lastSeq(clientId: string): number | undefined {
    return this.clients.get(clientId)?.last;
  }

  /** Every id a stored record ever had, the deleted ones included. */
  knownIds(): string[] {
    return [...this.ids];
  }

  /** Note the ids of the records stored now. A ban's id is the mock's
   * "<space>:<user>" (its members.ban), not a client's ULID, so it is not in
   * the id registry. */
  learn(dump: Dump) {
    for (const r of dump.values()) if ("id" in r && r.kind !== "ban") this.ids.add(r.id);
  }

  predict(dump: Dump, u: string | null, envelope: unknown, now: number): Prediction {
    const pass = (code: Code): Prediction => ({ code, usesSeq: false, stored: false });
    const e = envelope as Envelope;
    const isObject = e !== null && typeof e === "object";
    if (isObject && depthOf((e as { input?: unknown }).input) > 32) return pass("BAD_REQUEST");
    if (isObject && new TextEncoder().encode(JSON.stringify(e)).length > 256 * 1024)
      return pass("TOO_LARGE");
    const version = isObject ? (e as { protocolVersion?: unknown }).protocolVersion : undefined;
    if (typeof version === "number" && Number.isInteger(version) && version < 4)
      return pass("UPGRADE_REQUIRED");
    const replaces = isObject ? (e as { replaces?: unknown }).replaces : undefined;
    const shape =
      isObject &&
      Object.keys(e)
        .filter((k) => k !== "replaces")
        .sort()
        .join() === ENVELOPE_KEYS.join() &&
      (replaces === undefined ||
        (Array.isArray(replaces) &&
          replaces.length <= 16 &&
          replaces.every((x) => typeof x === "string" && ULID.test(x)))) &&
      typeof e.clientId === "string" &&
      typeof e.mutationId === "string" &&
      typeof e.name === "string" &&
      Number.isInteger(e.seq) &&
      e.seq >= 1 &&
      Number.isInteger(e.protocolVersion) &&
      Number.isInteger(e.clientTime) &&
      e.clientTime >= 0 &&
      Number.isInteger(e.queuedAt) &&
      e.queuedAt >= 0;
    if (!shape) return pass("BAD_REQUEST");
    if (u === null || !isHandle(u)) return pass("UNAUTHORIZED");
    const client = this.client(e.clientId, now);
    if (!client || client.u !== u) return pass("WRONG_CLIENT");
    client.seen = now;
    const formed = ULID.test(e.mutationId);
    const payload = sortedJson([e.name, e.input]);
    const prior = formed ? this.answers.get(`${u} ${e.mutationId}`) : undefined;
    const live = prior && now - prior.at < 7 * MIN_DAY ? prior : undefined;
    if (live && (live.payload === payload || live.payload === REPLACED)) return pass(live.code);
    const again = client.bySeq.get(e.seq);
    if (again && now - again.at < 7 * MIN_DAY && again.sent === sortedJson([e.mutationId, payload]))
      return pass(again.code);
    if (e.seq !== client.last + 1) return pass("OUT_OF_ORDER");
    if (!formed || live)
      return { code: "BAD_REQUEST", usesSeq: true, stored: false, storedForSeq: true };
    if (Math.abs(e.clientTime - now) > MINUTE_MS) return pass("CLOCK_SKEW");
    const stored = (code: Code): Prediction => ({ code, usesSeq: true, stored: true });
    if (!fresh(e.mutationId, e.clientTime)) return stored("EXPIRED");
    if (!freshTime(e.queuedAt, e.clientTime)) return stored("EXPIRED");
    const schema = Object.hasOwn(SCHEMA, e.name) ? SCHEMA[e.name] : undefined;
    const rules = Object.hasOwn(RULES, e.name) ? RULES[e.name] : undefined;
    if (!schema || !rules) return stored("NOT_FOUND");
    if (!schema(e.input)) return stored("BAD_REQUEST");
    const input = e.input as In;
    for (const k of NEW_IDS[e.name] ?? [])
      if (!fresh(String(input[k]), e.clientTime)) return stored("EXPIRED");
    if (e.name === "spaces.create" && e.clientTime - timeOf(e.mutationId) > MINUTE_MS)
      return stored("EXPIRED");
    const facts: Facts = {
      dump,
      me: u,
      nowSec: Math.floor(now / 1000) * 1000,
      idTaken: (id) => this.ids.has(id),
      randomDown: this.randomDown,
    };
    try {
      rules(facts, input);
    } catch (x) {
      if (x instanceof No)
        return x.code === "INTERNAL_SERVER_ERROR" ? pass(x.code) : stored(x.code);
      throw x;
    }
    return stored("ok");
  }

  /** Apply a prediction (which the suite has checked against the server's
   * answer) to the model's protocol state. */
  commit(u: string | null, envelope: Envelope, p: Prediction, now: number) {
    if (u === null) return;
    const client = this.clients.get(envelope.clientId);
    if (p.usesSeq && client) client.last = envelope.seq;
    if (p.storedForSeq && client)
      client.bySeq.set(envelope.seq, {
        sent: sortedJson([envelope.mutationId, sortedJson([envelope.name, envelope.input])]),
        code: p.code,
        at: now,
      });
    if (p.stored) {
      this.answers.set(`${u} ${envelope.mutationId}`, {
        payload: sortedJson([envelope.name, envelope.input]),
        code: p.code,
        at: now,
      });
      for (const id of envelope.replaces ?? []) {
        const old = this.answers.get(`${u} ${id}`);
        if (id !== envelope.mutationId && !(old && now - old.at < 7 * MIN_DAY))
          this.answers.set(`${u} ${id}`, { payload: REPLACED, code: p.code, at: now });
      }
    }
    for (const [k, a] of this.answers) if (now - a.at >= 7 * MIN_DAY) this.answers.delete(k);
  }
}
