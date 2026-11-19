// The suite's write oracle: a reference model of the server's answer to one
// envelope, written apart from `src/mutators.ts`, `src/access.ts` and
// `src/server.ts`. It predicts ok or the refusal's code, and whether the
// answer is recorded, from:
// - the rules below, taken from the mock's PROCS and `who` checks
//   (`docs/mockups/session-web-spaces-mock-api.js`, sections 5a and 5b), the
//   decided rules in AGENTS.md and the owner's decisions of phase 0b;
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
//   0. an input nested more than 32 deep, or an envelope larger than 256 KB
//      as JSON: BAD_REQUEST (round 2, decision 8)              unrecorded
//   1. protocolVersion an integer below 3: UPGRADE_REQUIRED    unrecorded
//   2. envelope: exactly { clientId, seq ≥ 1, mutationId, name, input,
//      protocolVersion, clientTime ≥ 0 }, else BAD_REQUEST     unrecorded
//   3. signed out, or a handle no person may have: UNAUTHORIZED unrecorded
//   4. the client id unknown, another user's, or not used for 90 days:
//      WRONG_CLIENT                                            unrecorded
//   5. a stored answer for (user, mutation id) with the same name and input
//      (key order aside), within 7 days: that answer, under any client id
//      or seq of the user                                      unrecorded
//   6. an answer stored for (client, seq) with the same mutation id, name
//      and input, within 7 days: that answer                   unrecorded
//   7. seq not the client's last + 1: OUT_OF_ORDER             unrecorded
//   8. a mutation id that is not a ULID, or one stored with another payload:
//      BAD_REQUEST                      uses the seq, stored for (client, seq)
//   9. clientTime more than a minute from the server's time: CLOCK_SKEW
//      (round 2, decision 3: only the device's clock against the server's)
//                                                              unrecorded
//  10. the mutation id's age on the device (clientTime − its time) above 4
//      days or below −1 minute: EXPIRED                        stored
//  11. an unknown name: NOT_FOUND; 12. an input outside the schema:
//      BAD_REQUEST                                             stored
//  13. a new id in the input with such an age: EXPIRED         stored
//  14. an online-only write (spaces.create) whose mutation id is over a
//      minute old on the device: EXPIRED (it waited in an outbox) stored
//  15. the mutator's own rules (RULES below)                   stored
// "Stored" answers use the seq and are kept for replays for 7 days, under
// (user, mutation id). An answer that uses the seq is always stored (round
// 1, R7b). INTERNAL_SERVER_ERROR (the server's random source failed, in the
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
const ROLES = ["member", "mod", "admin", "owner"] as const;
type Role = (typeof ROLES)[number];
const RANK: Record<Role, number> = { member: 1, mod: 2, admin: 3, owner: 4 };

const isHandle = (u: unknown) => typeof u === "string" && HANDLE.test(u) && !RESERVED.includes(u);
const timeOf = (id: string) => [...id.slice(0, 10)].reduce((t, ch) => t * 32 + B32.indexOf(ch), 0);
/** An id's age on the device's clock is from −1 minute to 4 days. */
const fresh = (id: string, deviceNow: number) => {
  const age = deviceNow - timeOf(id);
  return age >= -MINUTE_MS && age <= 4 * MIN_DAY;
};
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
const bool: Check = (v) => typeof v === "boolean";
const ulid: Check = (v) => typeof v === "string" && ULID.test(v);
const nat: Check = (v) => typeof v === "number" && Number.isInteger(v) && v >= 0;
const oneOf =
  (...xs: unknown[]): Check =>
  (v) =>
    xs.includes(v);
const role = oneOf(...ROLES);
const handle: Check = isHandle;
const strings: Check = (v) => Array.isArray(v) && v.every(str);
const questions: Check = (v) => Array.isArray(v) && v.every(obj({ q: str }, { req: bool }));
const itemKey: Check = (v) =>
  typeof v === "string" && /^[a-z]+:[0-9A-HJKMNP-TV-Z]{26}(:.*)?$/.test(v);
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
const vis = oneOf("open", "listed", "unlisted");
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

const SCHEMA: Record<string, Check> = {
  "spaces.create": obj(
    { id: ulid, name: str },
    {
      vis,
      policy: oneOf("request", "invite"),
      invite: oneOf("mods", "members"),
      desc: str,
      rules: strings,
      qs: questions,
    },
  ),
  "spaces.update": obj(
    { id: ulid },
    {
      set: obj(
        {},
        {
          name: str,
          title: str,
          desc: str,
          rules: strings,
          qs: questions,
          vis,
          policy: oneOf("request", "invite"),
          invite: oneOf("mods", "members"),
          postsOff: bool,
        },
      ),
      base: obj({ rulesRev: nat }),
      force: bool,
    },
  ),
  "spaces.join": obj({ space: ulid }, { invite: str }),
  "spaces.leave": obj({ space: ulid }),
  "threads.create": obj(
    { id: ulid, space: ulid, kind: oneOf("ask", "post"), q: str },
    { title: (v) => v === null || str(v) },
  ),
  "threads.update": obj({ id: ulid, q: str, base: obj({ rev: nat }) }),
  "threads.delete": obj({ id: ulid }),
  "likes.set": obj({ thread: ulid, on: bool }),
  "saved.set": obj({ kind: oneOf("thread"), id: ulid, on: bool }),
  "followups.ask": obj({ id: ulid, thread: ulid, q: str }),
  "research.createPostFollowUp": obj({ id: ulid, thread: ulid, t: str }, { parent: ulid }),
  "joinRequests.create": obj({ space: ulid }, { answers: strings, rulesAccepted: bool }),
  "joinRequests.decide": (v) =>
    obj(
      {
        space: ulid,
        users: (x) => Array.isArray(x) && x.length > 0 && x.every(handle),
        decision: oneOf("approve", "decline", "reopen"),
        base: revsFor(v),
      },
      { why: str },
    )(v),
  "members.setRole": obj({ space: ulid, user: handle, role, base: rev }),
  "members.remove": obj({ space: ulid, user: handle, base: obj({ adm: str }) }),
  "members.ban": obj({ space: ulid, user: handle }),
  "invites.create": obj({ id: ulid, space: ulid }, { days: (v) => v === null || nat(v) }),
  "reports.create": obj({ id: ulid, item: itemKey, why: str }, { note: str }),
  "moderation.decide": obj({
    item: itemKey,
    decision: oneOf("hidden", "removed", "shown"),
    base: rev,
  }),
};

/** The input fields that carry a new client-made id. */
const NEW_IDS: Record<string, string[]> = {
  "spaces.create": ["id"],
  "threads.create": ["id"],
  "followups.ask": ["id"],
  "research.createPostFollowUp": ["id"],
  "invites.create": ["id"],
  "reports.create": ["id"],
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

const spaceAt = (f: Facts, sp: string) => {
  const s = f.dump.get(`space:${sp}`);
  return s?.kind === "space" ? s : undefined;
};
const closed = (s: Space) => s.vis !== "open";
const roleOf = (f: Facts, sp: string, u: string): Role | null => {
  const m = f.dump.get(`member:${sp}:${u}`);
  return m?.kind === "member" ? m.role : null;
};
const rank = (f: Facts, sp: string, u: string) => {
  const r = roleOf(f, sp, u);
  return r ? RANK[r] : 0;
};
const banned = (f: Facts, sp: string, u: string) => f.dump.has(`ban:${sp}:${u}`);
/** A stored record's rev, 0 when there is none. */
const revAt = (f: Facts, key: string) => f.dump.get(key)?.rev ?? 0;
const baseRev = (i: In) => (i["base"] as { rev: number }).rev;
const blank = (v: unknown) => String(v).trim() === "";
/** The space's record, or NOT_FOUND; then: a banned actor is refused every
 * write there; then the role `need` (0: any signed-in person; "member": a
 * member of a closed space, anyone in an open one). */
function inSpace(f: Facts, sp: string, need: 0 | "member" | Role): Space {
  const s = spaceAt(f, sp) ?? no("NOT_FOUND");
  if (banned(f, sp, f.me)) no("FORBIDDEN");
  if (need === "member") {
    if (closed(s) && roleOf(f, sp, f.me) === null) no("FORBIDDEN");
  } else if (need !== 0 && rank(f, sp, f.me) < RANK[need]) no("FORBIDDEN");
  return s;
}

/** A thread the actor may read, or NOT_FOUND (one answer for both). */
function seenThread(f: Facts, id: unknown): Thread {
  const p = f.dump.get(`thread:${String(id)}`);
  if (p?.kind !== "thread" || !mayRead(f.dump, p, f.me)) no("NOT_FOUND");
  return p as Thread;
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
  if ((k === "f" || k === "r") && sub) {
    const r = f.dump.get(`${k === "f" ? "followup" : "reply"}:${sub}`);
    const want = k === "f" ? "followup" : "reply";
    if (!r || r.kind !== want || r.th !== th || !mayRead(f.dump, r, f.me)) no("NOT_FOUND");
    return r as Extract<StoredRecord, { kind: "followup" | "reply" }>;
  }
  return no("NOT_FOUND");
}

/** The mock's `actsOn` (the page's cxCanAct): on members ranked below you;
 * admins and the owner on admins too; never on the owner or yourself. "Someone
 * not in the list counts as a member" (the mock's words), so a moderator may
 * ban a person who never joined. */
function actOn(f: Facts, sp: string, u: string) {
  if (u === f.me) no("FORBIDDEN");
  const target = roleOf(f, sp, u) ?? "member";
  if (target === "owner") no("FORBIDDEN");
  const mine = rank(f, sp, f.me);
  if (target === "admin" ? mine < RANK.admin : mine <= RANK[target]) no("FORBIDDEN");
}

const makesLinks = (f: Facts, s: Space, u: string) =>
  rank(f, s.id, u) >= RANK.mod ||
  (closed(s) && s.invite === "members" && roleOf(f, s.id, u) !== null);

const RULES: Record<string, (f: Facts, i: In) => void> = {
  "spaces.create": (f, i) => {
    const name = slug(String(i["name"]));
    if (!name) no("BAD_REQUEST");
    for (const r of f.dump.values()) if (r.kind === "space" && r.name === name) no("CONFLICT");
    if (f.idTaken(String(i["id"]))) no("CONFLICT");
  },
  "spaces.update": (f, i) => {
    const s = inSpace(f, String(i["id"]), "admin");
    const set = (i["set"] ?? {}) as In;
    if (set["name"] !== undefined) {
      const name = slug(set["name"] as string);
      if (!name) no("BAD_REQUEST");
      if (name !== s.name)
        for (const r of f.dump.values()) if (r.kind === "space" && r.name === name) no("CONFLICT");
    }
    const rules = set["rules"]
      ? (set["rules"] as string[]).map((x) => x.trim()).filter(Boolean)
      : s.rules;
    const base = i["base"] as { rulesRev: number } | undefined;
    if (
      rules.join("\n") !== s.rules.join("\n") &&
      base &&
      !i["force"] &&
      base.rulesRev !== s.rulesRev
    )
      no("CONFLICT");
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
      (link.expiresAt === null || Date.parse(link.expiresAt) > f.nowSec) &&
      makesLinks(f, s, link.by);
    if (!live) no("FORBIDDEN");
  },
  "spaces.leave": (f, i) => {
    const sp = String(i["space"]);
    inSpace(f, sp, "member");
    if (roleOf(f, sp, f.me) === "owner") {
      const others = [...f.dump.values()].some(
        (r) => r.kind === "member" && r.sp === sp && r.role === "owner" && r.u !== f.me,
      );
      if (!others) no("PRECONDITION_FAILED");
    }
  },
  "threads.create": (f, i) => {
    const s = inSpace(f, String(i["space"]), "member");
    if (i["kind"] === "post" && s.postsOff) no("PRECONDITION_FAILED");
    if (blank(i["q"])) no("BAD_REQUEST");
    if (f.idTaken(String(i["id"]))) no("CONFLICT");
  },
  "threads.update": (f, i) => {
    const p = seenThread(f, i["id"]);
    inSpace(f, p.s, 0);
    if (p.u !== f.me) no("FORBIDDEN");
    if (p.mod === "removed" || p.del || p.gone) no("PRECONDITION_FAILED");
    if (p.rev !== (i["base"] as { rev: number }).rev) no("STALE");
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
  "likes.set": (f, i) => {
    const mine = f.dump.has(`like:${f.me}:${String(i["thread"])}`);
    if (i["on"] === false) {
      const p = f.dump.get(`thread:${String(i["thread"])}`);
      if (mine && p?.kind === "thread") inSpace(f, p.s, 0);
      return;
    }
    const p = seenThread(f, i["thread"]);
    inSpace(f, p.s, 0);
    if (!mine && p.mod === "removed") no("PRECONDITION_FAILED");
  },
  "saved.set": (f, i) => {
    if (i["on"] === false) {
      const p = f.dump.get(`thread:${String(i["id"])}`);
      if (f.dump.has(`save:${f.me}:${String(i["id"])}`) && p?.kind === "thread") inSpace(f, p.s, 0);
      return;
    }
    inSpace(f, seenThread(f, i["id"]).s, 0);
  },
  "followups.ask": (f, i) => {
    const p = seenThread(f, i["thread"]);
    inSpace(f, p.s, "member");
    if (p.k !== "ask") no("BAD_REQUEST");
    if (p.mod === "removed") no("PRECONDITION_FAILED");
    if (blank(i["q"])) no("BAD_REQUEST");
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
  "joinRequests.create": (f, i) => {
    const s = inSpace(f, String(i["space"]), 0);
    if (!closed(s) || s.policy === "invite" || roleOf(f, s.id, f.me) !== null)
      no("PRECONDITION_FAILED");
    const answers = (i["answers"] as string[] | undefined) ?? [];
    if (s.qs.some((q, k) => q.req && !(answers[k] ?? "").trim())) no("BAD_REQUEST");
    if (s.rules.length > 0 && i["rulesAccepted"] !== true) no("BAD_REQUEST");
  },
  "joinRequests.decide": (f, i) => {
    const sp = String(i["space"]);
    inSpace(f, sp, "mod");
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
  "members.setRole": (f, i) => {
    const sp = String(i["space"]);
    const user = String(i["user"]);
    const next = i["role"] as Role;
    inSpace(f, sp, "admin");
    if (next === "owner" && roleOf(f, sp, f.me) !== "owner") no("FORBIDDEN");
    actOn(f, sp, user);
    if (next !== "owner" && RANK[next] > rank(f, sp, f.me)) no("FORBIDDEN");
    if (revAt(f, `member:${sp}:${user}`) !== baseRev(i)) no("STALE");
    if (roleOf(f, sp, user) === null) no("NOT_FOUND");
  },
  "members.remove": (f, i) => {
    inSpace(f, String(i["space"]), "mod");
    actOn(f, String(i["space"]), String(i["user"]));
    // round 2: the admission id the moderator saw; nothing to do for a person
    // who is no longer a member
    const m = f.dump.get(`member:${String(i["space"])}:${String(i["user"])}`);
    if (m?.kind === "member" && m.adm !== (i["base"] as { adm: string }).adm) no("STALE");
  },
  // round 2: a ban takes the person as they are, and has no base
  "members.ban": (f, i) => {
    inSpace(f, String(i["space"]), "mod");
    actOn(f, String(i["space"]), String(i["user"]));
  },
  "invites.create": (f, i) => {
    const s = inSpace(f, String(i["space"]), "member");
    if (!makesLinks(f, s, f.me)) no("FORBIDDEN");
    // the code comes from the server's random source, before the record is written
    if (f.randomDown) no("INTERNAL_SERVER_ERROR");
    if (f.idTaken(String(i["id"]))) no("CONFLICT");
  },
  "reports.create": (f, i) => {
    const item = seenItem(f, String(i["item"]));
    inSpace(f, item.s, "member");
    if (blank(i["why"])) no("BAD_REQUEST");
    if (f.idTaken(String(i["id"]))) no("CONFLICT");
  },
  "moderation.decide": (f, i) => {
    const item = seenItem(f, String(i["item"]));
    inSpace(f, item.s, "mod");
    const d = i["decision"];
    // round 2: only "shown" could expose text, so only it compares the rev
    if (d === "shown" && item.rev !== baseRev(i)) no("STALE");
    if (item.mod === "removed") no("PRECONDITION_FAILED");
    if (d === "hidden" && item.mod !== null) no("PRECONDITION_FAILED");
    if (d === "shown" && item.mod !== "hidden") no("PRECONDITION_FAILED");
  },
};

const ENVELOPE_KEYS = [
  "clientId",
  "clientTime",
  "input",
  "mutationId",
  "name",
  "protocolVersion",
  "seq",
];
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
    if (
      isObject &&
      (depthOf((e as { input?: unknown }).input) > 32 ||
        new TextEncoder().encode(JSON.stringify(e)).length > 256 * 1024)
    )
      return pass("BAD_REQUEST");
    const version = isObject ? (e as { protocolVersion?: unknown }).protocolVersion : undefined;
    if (typeof version === "number" && Number.isInteger(version) && version < 3)
      return pass("UPGRADE_REQUIRED");
    const shape =
      isObject &&
      Object.keys(e).sort().join() === ENVELOPE_KEYS.join() &&
      typeof e.clientId === "string" &&
      typeof e.mutationId === "string" &&
      typeof e.name === "string" &&
      Number.isInteger(e.seq) &&
      e.seq >= 1 &&
      Number.isInteger(e.protocolVersion) &&
      Number.isInteger(e.clientTime) &&
      e.clientTime >= 0;
    if (!shape) return pass("BAD_REQUEST");
    if (u === null || !isHandle(u)) return pass("UNAUTHORIZED");
    const client = this.client(e.clientId, now);
    if (!client || client.u !== u) return pass("WRONG_CLIENT");
    client.seen = now;
    const formed = ULID.test(e.mutationId);
    const payload = sortedJson([e.name, e.input]);
    const prior = formed ? this.answers.get(`${u} ${e.mutationId}`) : undefined;
    const live = prior && now - prior.at < 7 * MIN_DAY ? prior : undefined;
    if (live && live.payload === payload) return pass(live.code);
    const again = client.bySeq.get(e.seq);
    if (again && now - again.at < 7 * MIN_DAY && again.sent === sortedJson([e.mutationId, payload]))
      return pass(again.code);
    if (e.seq !== client.last + 1) return pass("OUT_OF_ORDER");
    if (!formed || live)
      return { code: "BAD_REQUEST", usesSeq: true, stored: false, storedForSeq: true };
    if (Math.abs(e.clientTime - now) > MINUTE_MS) return pass("CLOCK_SKEW");
    const stored = (code: Code): Prediction => ({ code, usesSeq: true, stored: true });
    if (!fresh(e.mutationId, e.clientTime)) return stored("EXPIRED");
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
    if (p.stored)
      this.answers.set(`${u} ${envelope.mutationId}`, {
        payload: sortedJson([envelope.name, envelope.input]),
        code: p.code,
        at: now,
      });
    for (const [k, a] of this.answers) if (now - a.at >= 7 * MIN_DAY) this.answers.delete(k);
  }
}
