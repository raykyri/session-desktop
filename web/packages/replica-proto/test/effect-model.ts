// The write oracle's effect model: for a write the oracle predicts `ok`, the
// records it changes. It is written apart from `src/mutators.ts`, from the
// mock's procedures (`docs/mockups/session-web-spaces-mock-api.js`, section
// 5b), AGENTS.md and the owner's decisions of phase 0b and review round 1,
// and reads the server's records before the write only as facts.
//
// A prediction names every key the write may change and the fields of it that
// matter (roles, membership, bans, counts, owners, moderation states,
// notification recipients, and text erased on removal), or that the key is
// gone after the write. Records whose keys the server makes (a run's derived
// id, a notification's id) are predicted by kind and fields. `check` compares
// a prediction with the server's records before and after the write: every
// changed key must be predicted, and every predicted key must hold the
// predicted fields.

import type { StoredRecord } from "../src/index.js";

import { mayRead } from "./oracle.js";

type Dump = ReadonlyMap<string, StoredRecord>;
type In = Record<string, unknown>;
type Fields = Record<string, unknown>;

export interface Prediction {
  /** key → the fields the record holds after the write, or null: no record. */
  keys: Map<string, Fields | null>;
  /** New records whose key the server makes: kind and fields. */
  fresh: Fields[];
  /** The write's result, as far as the model knows it. */
  result?: (r: unknown) => boolean;
}

const RANK: Record<string, number> = { member: 1, mod: 2, admin: 3, owner: 4 };

/** The mock's name rule (spaces.create): lower case, a leading "#" dropped,
 * every run of other characters a "-", leading "-" dropped, 32 characters. */
const slug = (n: string) =>
  n
    .toLowerCase()
    .replace(/^#/, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 32);

const isClosed = (dump: Dump, sp: string) => {
  const s = dump.get(`space:${sp}`);
  return s?.kind === "space" && s.vis !== "open";
};

/** The members of a space after the write: the stored ones with `change`
 * applied (handle → role, or null for no longer a member). */
function membersAfter(dump: Dump, sp: string, change: Map<string, string | null>) {
  const out = new Map<string, string>();
  for (const r of dump.values()) if (r.kind === "member" && r.sp === sp) out.set(r.u, r.role);
  for (const [u, role] of change)
    if (role === null) out.delete(u);
    else out.set(u, role);
  return out;
}

/** The space record's member count and staff list (the mock's `mods`: the
 * owner, admins and moderators, by rank and then handle). */
function spaceFields(members: Map<string, string>): Fields {
  const staff = [...members]
    .filter(([, role]) => role !== "member")
    .sort(([a, x], [b, y]) => (RANK[y] ?? 0) - (RANK[x] ?? 0) || (a < b ? -1 : a > b ? 1 : 0));
  return { members: members.size, mods: staff };
}

/** Predict the records a write changes, for a write the oracle predicts ok. */
export function predictEffects(
  dump: Dump,
  me: string,
  name: string,
  input: In,
  nowMs: number,
): Prediction {
  const keys = new Map<string, Fields | null>();
  const fresh: Fields[] = [];
  const out: Prediction = { keys, fresh };
  const get = (key: string) => dump.get(key) as (StoredRecord & Fields) | undefined;
  const str = (k: string) => String(input[k]);
  /** A change of membership in `sp`: the member records and the space record. */
  const members = (sp: string, change: Map<string, string | null>) => {
    for (const [u, role] of change)
      keys.set(`member:${sp}:${u}`, role === null ? null : { sp, u, role });
    keys.set(`space:${sp}`, spaceFields(membersAfter(dump, sp, change)));
  };
  const children = (th: string) =>
    [...dump.entries()].filter(
      ([, r]) => (r.kind === "followup" || r.kind === "reply" || r.kind === "run") && r.th === th,
    );

  switch (name) {
    case "spaces.create": {
      const id = str("id");
      const vis = (input["vis"] as string | undefined) ?? "open";
      keys.set(`space:${id}`, {
        id,
        name: slug(str("name")),
        vis,
        members: 1,
        mods: [[me, "owner"]],
        rulesRev: 0,
      });
      keys.set(`stats:${id}`, { sp: id, posts: 0 });
      keys.set(`member:${id}:${me}`, { sp: id, u: me, role: "owner" });
      out.result = (r) => JSON.stringify(r) === JSON.stringify({ id });
      break;
    }
    case "spaces.update": {
      const sp = str("id");
      const s = get(`space:${sp}`) as Extract<StoredRecord, { kind: "space" }>;
      const set = (input["set"] ?? {}) as In;
      const vis = (set["vis"] as string | undefined) ?? s.vis;
      const rules = set["rules"]
        ? (set["rules"] as string[]).map((x) => x.trim()).filter(Boolean)
        : s.rules;
      const changed = rules.join("\n") !== s.rules.join("\n");
      const fields: Fields = {
        name: typeof set["name"] === "string" ? slug(set["name"]) : s.name,
        vis,
        rulesRev: s.rulesRev + (changed ? 1 : 0),
        postsOff: set["postsOff"] ?? s.postsOff,
        members: s.members,
        mods: s.mods,
      };
      keys.set(`space:${sp}`, fields);
      // the mock: a closed space that becomes open approves its open
      // requests and adds their people; a person banned from the space can't
      // join it, so a banned requester is approved but not added
      if (s.vis !== "open" && vis === "open") {
        const change = new Map<string, string | null>();
        for (const r of dump.values())
          if (r.kind === "request" && r.sp === sp && r.st === "open") {
            keys.set(`request:${sp}:${r.u}`, { st: "approved" });
            if (!dump.has(`ban:${sp}:${r.u}`) && !dump.has(`member:${sp}:${r.u}`))
              change.set(r.u, "member");
          }
        for (const [u, role] of change) keys.set(`member:${sp}:${u}`, { sp, u, role });
        Object.assign(fields, spaceFields(membersAfter(dump, sp, change)));
      }
      break;
    }
    case "spaces.join": {
      const sp = str("space");
      if (dump.has(`member:${sp}:${me}`)) break;
      members(sp, new Map([[me, "member"]]));
      if (isClosed(dump, sp) && input["invite"] !== undefined) {
        const link = [...dump.entries()].find(
          ([, r]) => r.kind === "invite" && r.code === input["invite"],
        );
        if (link) keys.set(link[0], { dead: "Used", usedBy: me });
      }
      break;
    }
    case "spaces.leave": {
      const sp = str("space");
      if (dump.has(`member:${sp}:${me}`)) members(sp, new Map([[me, null]]));
      break;
    }
    case "threads.create": {
      const id = str("id");
      const sp = str("space");
      const ask = input["kind"] === "ask";
      keys.set(`thread:${id}`, {
        id,
        s: sp,
        u: me,
        k: input["kind"],
        q: str("q").trim(),
        t: input["title"] ?? null,
        sum: null,
        likes: 0,
        r: 0,
        running: ask,
        del: false,
        gone: false,
        mod: null,
      });
      const stats = get(`stats:${sp}`);
      if (stats) keys.set(`stats:${sp}`, { posts: Number(stats["posts"]) + 1 });
      // an ask starts a run (the mock's threads.create: "An ask starts a run")
      if (ask) fresh.push({ kind: "run", th: id, s: sp, u: me, status: "queued" });
      out.result = (r) => {
        const x = r as { id?: unknown; run?: unknown } | null;
        return x?.id === id && (ask ? typeof x.run === "string" : x.run === null);
      };
      break;
    }
    case "threads.update": {
      const p = get(`thread:${str("id")}`) as Extract<StoredRecord, { kind: "thread" }>;
      const q = str("q").trim();
      keys.set(`thread:${p.id}`, {
        q,
        t: q === p.q ? p.t : null,
        edited: p.edited || q !== p.q,
        mod: p.mod,
        likes: p.likes,
        r: p.r,
      });
      break;
    }
    case "threads.delete": {
      const p = get(`thread:${str("id")}`) as Extract<StoredRecord, { kind: "thread" }>;
      // the mock: a thread with follow-ups (an ask) or replies (a post) keeps
      // its place; one without is gone and leaves Saved and likes
      const kids = [...dump.values()].filter((r) =>
        p.k === "ask"
          ? r.kind === "followup" && r.th === p.id
          : r.kind === "reply" && r.th === p.id && r.parent === null,
      ).length;
      const kept = kids > 0;
      keys.set(`thread:${p.id}`, {
        del: true,
        gone: !kept,
        q: "",
        t: null,
        running: false,
        sum: kept ? p.sum : null,
        likes: kept ? p.likes : 0,
        mod: p.mod,
      });
      for (const [k, r] of dump) {
        if (r.kind === "run" && r.th === p.id) keys.set(k, null);
        if (!kept && (r.kind === "like" || r.kind === "save") && r.th === p.id) keys.set(k, null);
      }
      // round 1, R4b: an author who may no longer read it is told nothing
      const reads = mayRead(dump, p, me);
      out.result = (r) => JSON.stringify(r) === JSON.stringify(reads ? { kept } : null);
      break;
    }
    case "likes.set": {
      const th = str("thread");
      const had = dump.has(`like:${me}:${th}`);
      const on = input["on"] === true;
      if (on === had) break;
      keys.set(`like:${me}:${th}`, on ? { u: me, th } : null);
      const p = get(`thread:${th}`);
      if (p) keys.set(`thread:${th}`, { likes: Math.max(0, Number(p["likes"]) + (on ? 1 : -1)) });
      break;
    }
    case "saved.set": {
      const th = str("id");
      const had = dump.has(`save:${me}:${th}`);
      const on = input["on"] === true;
      if (on !== had) keys.set(`save:${me}:${th}`, on ? { u: me, th } : null);
      break;
    }
    case "followups.ask": {
      const p = get(`thread:${str("thread")}`) as Extract<StoredRecord, { kind: "thread" }>;
      keys.set(`followup:${str("id")}`, {
        th: p.id,
        s: p.s,
        u: me,
        q: str("q").trim(),
        a: null,
        mod: null,
      });
      keys.set(`thread:${p.id}`, { r: p.r + 1, likes: p.likes });
      break;
    }
    case "research.createPostFollowUp": {
      const p = get(`thread:${str("thread")}`) as Extract<StoredRecord, { kind: "thread" }>;
      const parent = (input["parent"] as string | undefined) ?? null;
      keys.set(`reply:${str("id")}`, {
        th: p.id,
        s: p.s,
        u: me,
        t: str("t").trim(),
        parent,
        mod: null,
      });
      // a top-level reply counts for its post; a reply to a reply does not
      if (parent === null) keys.set(`thread:${p.id}`, { r: p.r + 1 });
      break;
    }
    case "joinRequests.create": {
      const sp = str("space");
      keys.set(`request:${sp}:${me}`, {
        sp,
        u: me,
        st: "open",
        a: input["answers"] ?? [],
        why: null,
      });
      break;
    }
    case "joinRequests.decide": {
      const sp = str("space");
      const d = input["decision"];
      const change = new Map<string, string | null>();
      for (const u of new Set(input["users"] as string[])) {
        const st = d === "approve" ? "approved" : d === "decline" ? "declined" : "open";
        keys.set(`request:${sp}:${u}`, {
          st,
          ...(d === "decline" ? { why: ((input["why"] as string | undefined) ?? "").trim() } : {}),
        });
        if (d === "approve" && !dump.has(`member:${sp}:${u}`)) change.set(u, "member");
      }
      // the space record is written again in any case (its counts)
      members(sp, change);
      break;
    }
    case "members.setRole": {
      const sp = str("space");
      const role = str("role");
      const change = new Map<string, string | null>([[str("user"), role]]);
      // the mock: role "owner" transfers ownership; the old owner becomes an admin
      if (role === "owner") change.set(me, "admin");
      members(sp, change);
      break;
    }
    case "members.remove": {
      const sp = str("space");
      const user = str("user");
      if (dump.has(`member:${sp}:${user}`)) members(sp, new Map([[user, null]]));
      break;
    }
    case "members.ban": {
      const sp = str("space");
      const user = str("user");
      members(sp, new Map([[user, null]]));
      // the mock's ban record: id "<space>:<user>", one per person and space
      keys.set(`ban:${sp}:${user}`, { id: `${sp}:${user}`, sp, u: user });
      break;
    }
    case "invites.create": {
      const id = str("id");
      const days = input["days"] as number | null | undefined;
      const now = Math.floor(nowMs / 1000) * 1000;
      keys.set(`invite:${id}`, {
        id,
        by: me,
        sp: str("space"),
        dead: null,
        usedBy: null,
        expiresAt: days
          ? new Date(now + days * 86_400_000).toISOString().replace(".000Z", "Z")
          : null,
      });
      out.result = (r) => {
        const x = r as { id?: unknown; code?: unknown } | null;
        return (
          x?.id === id && typeof x.code === "string" && /^[0-9a-hjkmnp-tv-z]{10}$/.test(x.code)
        );
      };
      break;
    }
    case "reports.create": {
      const id = str("id");
      const item = str("item");
      const [, th] = item.split(":");
      const p = get(`thread:${th ?? ""}`);
      const sp = String(p?.["s"]);
      keys.set(`report:${id}`, { sp, key: item, by: me, st: "open", why: str("why").trim() });
      // the mock: the space's moderators get a notification (here: its
      // owner, admins and moderators)
      for (const [u, role] of membersAfter(dump, sp, new Map()))
        if (role !== "member")
          fresh.push({ kind: "notif", to: u, type: "report", sp, report: id, item });
      out.result = (r) => JSON.stringify(r) === JSON.stringify({ id, sp });
      break;
    }
    case "moderation.decide": {
      const [k, th, sub] = str("item").split(":");
      const key = k === "f" ? `followup:${sub}` : k === "r" ? `reply:${sub}` : `thread:${th}`;
      const r = get(key) as StoredRecord & Fields;
      const d = input["decision"];
      if (d === "hidden") keys.set(key, { mod: "hidden", ...text(r) });
      else if (d === "shown") keys.set(key, { mod: null, ...text(r) });
      else {
        // removed: erased for good, with everything under it (owner
        // decision, 0b): a thread's follow-ups, runs and replies; a top-level
        // reply's replies. The item stays as a placeholder with no text.
        if (r.kind === "thread") {
          keys.set(key, { mod: "removed", q: "", t: null, sum: null, r: 0, running: false });
          for (const [ck] of children(r.id)) keys.set(ck, null);
        } else if (r.kind === "followup") keys.set(key, { mod: "removed", q: "", a: null });
        else if (r.kind === "reply") {
          keys.set(key, { mod: "removed", t: "" });
          if (r.parent === null)
            for (const [ck, x] of dump)
              if (x.kind === "reply" && x.parent === r.id) keys.set(ck, null);
        }
      }
      break;
    }
  }
  return out;
}

/** The text fields of a moderated record, as they are: hiding or showing
 * keeps them. */
function text(r: StoredRecord): Fields {
  if (r.kind === "thread") return { q: r.q, t: r.t, sum: r.sum };
  if (r.kind === "followup") return { q: r.q, a: r.a };
  if (r.kind === "reply") return { t: r.t };
  return {};
}

/** How the server's change set differs from the prediction, or null. */
export function checkEffects(
  before: Dump,
  after: Dump,
  p: Prediction,
  result: unknown,
): string | null {
  const out: string[] = [];
  const fresh = [...p.fresh];
  const matches = (r: StoredRecord, f: Fields) =>
    Object.entries(f).every(
      ([k, v]) => JSON.stringify((r as unknown as Fields)[k]) === JSON.stringify(v),
    );
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const a = before.get(key);
    const b = after.get(key);
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    if (p.keys.has(key)) continue;
    // a record whose key the server made
    const k = b && !a ? fresh.findIndex((f) => f["kind"] === b.kind && matches(b, f)) : -1;
    if (k >= 0) fresh.splice(k, 1);
    else out.push(`unpredicted change of ${key}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
  }
  for (const [key, f] of p.keys) {
    const b = after.get(key);
    if (f === null) {
      if (b) out.push(`${key} should be gone: ${JSON.stringify(b)}`);
    } else if (!b) out.push(`${key} missing, want ${JSON.stringify(f)}`);
    else if (!matches(b, f)) out.push(`${key} is ${JSON.stringify(b)}, want ${JSON.stringify(f)}`);
  }
  for (const f of fresh) out.push(`missing new record ${JSON.stringify(f)}`);
  if (p.result && !p.result(result)) out.push(`unexpected result ${JSON.stringify(result)}`);
  return out.length ? out.slice(0, 5).join("\n") : null;
}
