// The write oracle's effect model: for a write the oracle predicts `ok`, the
// records it changes, its notifications included. It is written apart from
// `src/mutators.ts`, from the mock's procedures
// (`docs/mockups/session-web-spaces-mock-api.js`, section 5b), AGENTS.md,
// the owner's decisions of phase 0b and review round 1, and the
// implementation plan (`01` C1-C18), and reads the server's records before
// the write only as facts.
//
// A prediction names every key the write may change and the fields of it that
// matter (roles, admissions, membership, bans, counts, owners, moderation
// states, a space's About, text erased on removal, notifications), or that
// the key is gone after the write. Records whose keys the server makes (a
// run's or a notification's derived id, a moderation log entry) are
// predicted by kind and fields. A field may be predicted by a test (`Is`)
// where the server makes the value: an admission id is a ULID, and a new one
// differs from every admission id the person had in that space. `check`
// compares a prediction with the server's records before and after the
// write: every changed key must be predicted, and every predicted key must
// hold the predicted fields.
//
// Notifications are part of the write (`01` U1, C16): written in the same
// commit, once. Nobody is notified of their own action; `reply`, `branch`
// and `comment` coalesce into the recipient's unread notification of that
// type and thread; mentions notify members of the space.

import type { StoredRecord } from "../src/index.js";

import { mayRead } from "./oracle.js";

type Dump = ReadonlyMap<string, StoredRecord>;
type In = Record<string, unknown>;
type Fields = Record<string, unknown>;

/** A field predicted by a test on its value. */
class Is {
  constructor(
    readonly what: string,
    readonly test: (v: unknown) => boolean,
  ) {}
  toJSON() {
    return `<${this.what}>`;
  }
}
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const anId = () => new Is("an id", (v) => typeof v === "string" && ULID.test(v));

export interface Prediction {
  /** key → the fields the record holds after the write, or null: no record. */
  keys: Map<string, Fields | null>;
  /** New records whose key the server makes: kind and fields. */
  fresh: Fields[];
  /** The write's result, as far as the model knows it. */
  result?: (r: unknown) => boolean;
}

/** The channel name rule (`04` B1), written out step by step: spaces at
 * both ends dropped; lower case; a leading "#" dropped; then 2 to 30
 * characters, each a to z, 0 to 9 or "-", the first not "-". "" when the
 * name breaks the rule (the write is BAD_REQUEST). */
export function slug(n: string): string {
  let s = n.trim().toLowerCase();
  if (s.startsWith("#")) s = s.slice(1);
  const ok = (ch: string) => (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9") || ch === "-";
  if (s.length < 2 || s.length > 30 || s[0] === "-") return "";
  for (const ch of s) if (!ok(ch)) return "";
  return s;
}

/** A look-up phrase as stored: the words between the first and the last
 * letter or digit, joined by single spaces (`03` G2). */
function phrase(v: string): string {
  const chars = [...v];
  const word = (ch: string) => /[\p{L}\p{N}]/u.test(ch);
  while (chars.length && !word(chars[0] as string)) chars.shift();
  while (chars.length && !word(chars[chars.length - 1] as string)) chars.pop();
  return chars
    .join("")
    .split(/\s+/)
    .filter((x) => x !== "")
    .join(" ");
}

/** The look-up prompt the server stores in `q` (`03` G2, the mockup's text). */
const lookupPrompt = (p: string) =>
  'Look up "' +
  p +
  '" as it is used in this answer. Describe what it refers to in two or three sentences, with a source.';

/** The handles a text mentions: "@" after the start or a character that
 * cannot be in a handle, then a handle's characters, without trailing dots;
 * each once. */
function mentioned(t: string): string[] {
  const inHandle = (ch: string) => /[a-z0-9._-]/.test(ch);
  const out: string[] = [];
  for (let k = 0; k < t.length; k++) {
    if (t[k] !== "@") continue;
    const before = k === 0 ? "" : (t[k - 1] as string);
    if (before !== "" && (inHandle(before) || before === "@")) continue;
    let h = "";
    for (let j = k + 1; j < t.length && inHandle(t[j] as string) && h.length < 64; j++)
      h += t[j] as string;
    if (!/^[a-z0-9]/.test(h)) continue;
    while (h.endsWith(".")) h = h.slice(0, -1);
    if (h && !out.includes(h)) out.push(h);
  }
  return out;
}

const isClosed = (dump: Dump, sp: string) => {
  const s = dump.get(`space:${sp}`);
  return s?.kind === "space" && s.vis === "private";
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

/** Every admission id each person had in each space, by "<space>:<person>". */
export type Admissions = ReadonlyMap<string, ReadonlySet<string>>;

/** An admission id for `u` in `sp` that is new: a ULID other than every
 * admission id `u` had in `sp` (and the member record's before the write). */
const newAdmission = (dump: Dump, sp: string, u: string, had: Admissions) => {
  const old = dump.get(`member:${sp}:${u}`);
  const before = old?.kind === "member" ? old.adm : null;
  const used = had.get(`${sp}:${u}`);
  return new Is(
    "a new admission id",
    (v) => typeof v === "string" && ULID.test(v) && v !== before && !used?.has(v),
  );
};

/** Predict the records a write changes, for a write the oracle predicts ok. */
export function predictEffects(
  dump: Dump,
  me: string,
  name: string,
  input: In,
  nowMs: number,
  had: Admissions = new Map(),
): Prediction {
  const keys = new Map<string, Fields | null>();
  const fresh: Fields[] = [];
  const out: Prediction = { keys, fresh };
  const get = (key: string) => dump.get(key) as (StoredRecord & Fields) | undefined;
  const str = (k: string) => String(input[k]);
  /** A change of membership in `sp`: the member records and the space's count. */
  const members = (sp: string, change: Map<string, string | null>) => {
    for (const [u, role] of change) {
      const old = dump.get(`member:${sp}:${u}`);
      // a member record keeps its admission; a new member gets a new one
      const adm = old?.kind === "member" ? old.adm : newAdmission(dump, sp, u, had);
      keys.set(`member:${sp}:${u}`, role === null ? null : { sp, u, role, adm });
    }
    keys.set(`space:${sp}`, { members: membersAfter(dump, sp, change).size });
  };
  /** A notification of the actor's write, unless it is to the actor: a
   * coalescing type updates the recipient's unread one of that type and
   * thread, if there is one. */
  const notify = (
    to: string,
    type: string,
    sp: string,
    th: string,
    item: string,
    note: string | null = null,
  ) => {
    if (to === me) return;
    if (type === "reply" || type === "branch" || type === "comment") {
      const old = [...dump.entries()].find(
        ([, r]) => r.kind === "notif" && r.to === to && r.type === type && r.th === th && !r.read,
      );
      if (old) {
        const n = old[1] as StoredRecord & { n: number };
        keys.set(old[0], { to, type, th, item, actor: me, n: n.n + 1, read: false });
        return;
      }
    }
    fresh.push({
      kind: "notif",
      id: anId(),
      to,
      type,
      sp,
      th,
      item,
      actor: type === "removed" ? null : me,
      n: 1,
      note,
      read: false,
    });
  };
  /** Mention notifications for the members of `sp` that `t` names. */
  const mentions = (t: string, sp: string, th: string, item: string) => {
    for (const h of mentioned(t))
      if (dump.get(`member:${sp}:${h}`)?.kind === "member") notify(h, "mention", sp, th, item);
  };
  /** The author of the node a reference names in a thread: `r` the thread's. */
  const authorAt = (th: string, ref: string) =>
    String(get(ref === "r" ? `thread:${th}` : `node:${ref}`)?.["u"]);
  const ofThread = (th: string, ...kinds: string[]) =>
    [...dump.entries()].filter(
      ([, r]) => kinds.includes(r.kind) && "th" in r && (r as { th: string }).th === th,
    );
  /** A new run of an ask (the run queue, `03` E2). */
  const run = (th: string, sp: string, node: string) =>
    fresh.push({
      kind: "run",
      id: anId(),
      th,
      s: sp,
      node,
      u: me,
      model: input["model"],
      effort: input["effort"],
      status: "queued",
      attempt: 1,
      step: 0,
    });
  /** A run that has not ended, stopped by its asker (`03` E4). */
  const stopRun = (run: StoredRecord | undefined) => {
    if (run?.kind === "run" && (run.status === "queued" || run.status === "running"))
      keys.set(`run:${run.id}`, {
        status: "cancelled",
        fail: { why: "stopped", at: null, cls: null },
        attempt: run.attempt,
      });
  };
  /** The run of a node, or of the root (`r`). */
  const runAt = (th: string, ref: string) =>
    [...dump.values()].find(
      (r) =>
        r.kind === "run" &&
        (ref === "r"
          ? r.th === th && r.node === "r"
          : r.id === (get(`node:${ref}`) as { run?: string } | undefined)?.run),
    );
  /** A moderation log entry (`01` C12). */
  const modlog = (sp: string, act: string, item: string | null, author: string, note: unknown) =>
    fresh.push({ kind: "modlog", id: anId(), sp, act, item, by: me, author, note });
  /** The mention notifications about any of `erased` go with it. */
  const eraseMentions = (erased: Set<string>) => {
    for (const [k, r] of dump)
      if (r.kind === "notif" && r.type === "mention" && erased.has(r.item ?? "")) keys.set(k, null);
  };

  switch (name) {
    case "spaces.create": {
      const id = str("id");
      // the creator is the owner and only member; an empty About is ""
      keys.set(`space:${id}`, {
        id,
        name: slug(str("name")),
        desc: (typeof input["desc"] === "string" ? input["desc"] : "").trim(),
        vis: input["vis"] ?? "open",
        members: 1,
        owner: me,
        frozen: false,
      });
      keys.set(`stats:${id}`, { sp: id, posts: 0 });
      keys.set(`member:${id}:${me}`, {
        sp: id,
        u: me,
        role: "owner",
        adm: new Is("an admission id", (v) => typeof v === "string" && ULID.test(v)),
      });
      out.result = (r) => JSON.stringify(r) === JSON.stringify({ id });
      break;
    }
    case "spaces.update": {
      // About only; nothing else of the space changes
      const s = get(`space:${str("id")}`) as Extract<StoredRecord, { kind: "space" }>;
      keys.set(`space:${s.id}`, {
        name: s.name,
        vis: s.vis,
        owner: s.owner,
        members: s.members,
        desc: str("desc").trim(),
      });
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
      const from = input["from"] as { th: string; node: string } | undefined;
      if (from) {
        // a node opened as its own thread (`03` G5): its question, author,
        // model and effort, a copy of its answer; no run
        const n = get(`node:${from.node}`) as Extract<StoredRecord, { kind: "node" }>;
        const a = get(`answer:${n.id}`) as Extract<StoredRecord, { kind: "answer" }>;
        keys.set(`thread:${id}`, {
          id,
          s: n.s,
          u: n.u,
          k: "ask",
          q: n.q,
          t: null,
          sum: null,
          tok: a.tok,
          src: a.pages.length,
          model: n.model,
          effort: n.effort,
          running: false,
          del: false,
          gone: false,
          mod: null,
          from: { th: n.th, node: n.id },
        });
        keys.set(`counts:${id}`, { th: id, s: n.s, saves: 0, r: 0 });
        const st = get(`stats:${n.s}`);
        if (st) keys.set(`stats:${n.s}`, { posts: Number(st["posts"]) + 1 });
        keys.set(`answer:${id}`, { node: "r", th: id, s: n.s, u: n.u, md: a.md, mod: null });
        keys.set(`node:${n.id}`, { promoted: id, q: n.q });
        out.result = (r) => JSON.stringify(r) === JSON.stringify({ id, run: null });
        break;
      }
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
        tok: 0,
        src: 0,
        model: ask ? input["model"] : null,
        effort: ask ? input["effort"] : null,
        running: ask,
        del: false,
        gone: false,
        mod: null,
        modBy: null,
        modNote: null,
      });
      // the counts live apart from the thread (round 1, decision 4)
      keys.set(`counts:${id}`, { th: id, s: sp, saves: 0, r: 0 });
      const stats = get(`stats:${sp}`);
      if (stats) keys.set(`stats:${sp}`, { posts: Number(stats["posts"]) + 1 });
      // an ask queues its root run; a post notifies the members it mentions
      if (ask) run(id, sp, "r");
      else mentions(str("q"), sp, id, `thread:${id}`);
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
      });
      break;
    }
    case "threads.delete": {
      const p = get(`thread:${str("id")}`) as Extract<StoredRecord, { kind: "thread" }>;
      // a thread with nodes (an ask) or replies (a post) keeps its place; one
      // without is gone, leaves Saved and loses its root answer
      const kept = ofThread(p.id, p.k === "ask" ? "node" : "reply").length > 0;
      keys.set(`thread:${p.id}`, {
        del: true,
        gone: !kept,
        q: "",
        t: null,
        running: false,
        sum: kept ? p.sum : null,
        mod: p.mod,
      });
      if (!kept) keys.set(`counts:${p.id}`, { saves: 0 });
      for (const [k, r] of dump) {
        if (r.kind === "run" && r.th === p.id && r.node === "r") keys.set(k, null);
        if (!kept && r.kind === "save" && r.th === p.id) keys.set(k, null);
      }
      if (!kept && dump.has(`answer:${p.id}`)) keys.set(`answer:${p.id}`, null);
      // round 1, R4b: an author who may no longer read it is told nothing
      const reads = mayRead(dump, p, me);
      out.result = (r) => JSON.stringify(r) === JSON.stringify(reads ? { kept } : null);
      break;
    }
    case "saved.set": {
      const th = str("id");
      const had = dump.has(`save:${me}:${th}`);
      const on = input["on"] === true;
      if (on === had) break;
      keys.set(`save:${me}:${th}`, on ? { u: me, th } : null);
      // the served count: every save, but 0 below 3 in a private space (S6)
      const counts = get(`counts:${th}`);
      if (counts) {
        let n = 0;
        for (const r of dump.values()) if (r.kind === "save" && r.th === th) n++;
        n += on ? 1 : -1;
        const hide = isClosed(dump, String(counts["s"])) && n < 3;
        keys.set(`counts:${th}`, { saves: hide ? 0 : n });
      }
      break;
    }
    case "research.forkNode": {
      const p = get(`thread:${str("thread")}`) as Extract<StoredRecord, { kind: "thread" }>;
      const id = str("id");
      const look = input["kind"] === "lookup" ? phrase(str("look")) : null;
      keys.set(`node:${id}`, {
        id,
        th: p.id,
        s: p.s,
        par: input["parent"],
        k: input["kind"],
        u: me,
        q: look === null ? str("q").trim() : lookupPrompt(look),
        look,
        quote: input["quote"] ?? null,
        b: input["b"] ?? null,
        tpl: look === null ? null : 1,
        model: input["model"],
        effort: input["effort"],
        run: anId(),
        promoted: null,
        mod: null,
        del: false,
      });
      run(p.id, p.s, id);
      // `r` counts every node under the root (C5)
      keys.set(`counts:${p.id}`, { r: ofThread(p.id, "node").length + 1 });
      notify(authorAt(p.id, str("parent")), "branch", p.s, p.id, `node:${id}`);
      out.result = (r) => {
        const x = r as { id?: unknown; run?: unknown } | null;
        return x?.id === id && typeof x.run === "string";
      };
      break;
    }
    case "followups.update": {
      keys.set(`node:${str("node")}`, { q: str("q").trim(), mod: null, del: false });
      break;
    }
    case "followups.delete": {
      // a node with nodes or comments under it stays as a shell without
      // text; one without goes with its answer. Its run, if it has not
      // ended, is cancelled first (`03` G6).
      const n = get(`node:${str("node")}`) as Extract<StoredRecord, { kind: "node" }>;
      const kept = [...dump.values()].some(
        (r) => (r.kind === "node" && r.par === n.id) || (r.kind === "comment" && r.node === n.id),
      );
      stopRun(get(`run:${n.run}`));
      if (kept) keys.set(`node:${n.id}`, { q: "", look: null, quote: null, del: true });
      else {
        keys.set(`node:${n.id}`, null);
        if (dump.has(`answer:${n.id}`)) keys.set(`answer:${n.id}`, null);
        keys.set(`counts:${n.th}`, { r: ofThread(n.th, "node").length - 1 });
      }
      const reads = mayRead(dump, n, me);
      out.result = (r) => JSON.stringify(r) === JSON.stringify(reads ? { kept } : null);
      break;
    }
    case "research.cancelNode": {
      const th = str("thread");
      const run = runAt(th, str("node"));
      if (run?.kind === "run" && (run.status === "queued" || run.status === "running")) {
        stopRun(run);
        if (str("node") === "r") keys.set(`thread:${th}`, { running: false });
      }
      break;
    }
    case "research.retryNode": {
      // a new attempt, queued, on the model and effort picked now
      const th = str("thread");
      const ref = str("node");
      const run = runAt(th, ref) as Extract<StoredRecord, { kind: "run" }>;
      keys.set(`run:${run.id}`, {
        status: "queued",
        attempt: run.attempt + 1,
        model: input["model"],
        effort: input["effort"],
        fail: null,
        step: 0,
        finishedAt: null,
      });
      if (ref === "r")
        keys.set(`thread:${th}`, {
          model: input["model"],
          effort: input["effort"],
          running: true,
        });
      else keys.set(`node:${ref}`, { model: input["model"], effort: input["effort"] });
      break;
    }
    case "replies.update":
    case "comments.update": {
      const kind = name === "replies.update" ? "reply" : "comment";
      const old = get(`${kind}:${str("id")}`) as { t: string; edited: boolean };
      const t = str("t").trim();
      keys.set(`${kind}:${str("id")}`, {
        t,
        mod: null,
        del: false,
        edited: old.edited || t !== old.t,
      });
      break;
    }
    case "replies.delete":
    case "comments.delete": {
      // a top-level one with others under it stays, emptied; any other goes
      const kind = name === "replies.delete" ? "reply" : "comment";
      const r = get(`${kind}:${str("id")}`) as Extract<StoredRecord, { kind: "reply" | "comment" }>;
      const kept =
        r.parent === null &&
        [...dump.values()].some((x) => x.kind === kind && x.th === r.th && x.parent === r.id);
      if (kept) keys.set(`${kind}:${r.id}`, { t: "", del: true });
      else {
        keys.set(`${kind}:${r.id}`, null);
        if (kind === "reply") keys.set(`counts:${r.th}`, { r: ofThread(r.th, "reply").length - 1 });
      }
      const reads = mayRead(dump, r, me);
      out.result = (x) => JSON.stringify(x) === JSON.stringify(reads ? { kept } : null);
      break;
    }
    case "research.createPostFollowUp": {
      const p = get(`thread:${str("thread")}`) as Extract<StoredRecord, { kind: "thread" }>;
      const parent = (input["parent"] as string | undefined) ?? null;
      const id = str("id");
      keys.set(`reply:${id}`, {
        th: p.id,
        s: p.s,
        u: me,
        t: str("t").trim(),
        parent,
        mod: null,
      });
      // every reply counts for its post, at every depth (C5)
      keys.set(`counts:${p.id}`, { r: ofThread(p.id, "reply").length + 1 });
      notify(String(p.u), "reply", p.s, p.id, `reply:${id}`);
      mentions(str("t"), p.s, p.id, `reply:${id}`);
      break;
    }
    case "comments.create": {
      const p = get(`thread:${str("thread")}`) as Extract<StoredRecord, { kind: "thread" }>;
      const id = str("id");
      keys.set(`comment:${id}`, {
        th: p.id,
        s: p.s,
        node: input["node"],
        parent: input["parent"] ?? null,
        u: me,
        t: str("t").trim(),
        mod: null,
      });
      // a comment starts no run and changes no count (`03` G4)
      notify(authorAt(p.id, str("node")), "comment", p.s, p.id, `comment:${id}`);
      mentions(str("t"), p.s, p.id, `comment:${id}`);
      break;
    }
    case "joinRequests.create": {
      const sp = str("space");
      keys.set(`request:${sp}:${me}`, { sp, u: me, st: "open", why: null });
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
      // the space record is written again in any case (its count)
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
      // whatever the member record's rev or admission (round 2)
      members(sp, new Map([[user, null]]));
      // the mock's ban record: id "<space>:<user>", one per person and space;
      // a new ban is logged (C12)
      if (!dump.has(`ban:${sp}:${user}`)) {
        keys.set(`ban:${sp}:${user}`, { id: `${sp}:${user}`, sp, u: user });
        modlog(sp, "ban", null, user, null);
      }
      break;
    }
    case "members.unban": {
      const sp = str("space");
      const user = str("user");
      if (dump.has(`ban:${sp}:${user}`)) {
        keys.set(`ban:${sp}:${user}`, null);
        modlog(sp, "unban", null, user, null);
      }
      break;
    }
    case "invites.create": {
      const id = str("id");
      const days = input["days"] as number;
      const now = Math.floor(nowMs / 1000) * 1000;
      keys.set(`invite:${id}`, {
        id,
        by: me,
        sp: str("space"),
        dead: null,
        usedBy: null,
        expiresAt: new Date(now + days * 86_400_000).toISOString().replace(".000Z", "Z"),
      });
      // 26 base32 characters from the server's random source (`04` B4)
      out.result = (r) => {
        const x = r as { id?: unknown; code?: unknown } | null;
        return (
          x?.id === id && typeof x.code === "string" && /^[0-9a-hjkmnp-tv-z]{26}$/.test(x.code)
        );
      };
      break;
    }
    case "invites.revoke":
    case "invites.restore": {
      const key = `invite:${str("id")}`;
      const dead = get(key)?.["dead"];
      if (name === "invites.revoke" && dead === null) keys.set(key, { dead: "Revoked" });
      if (name === "invites.restore" && dead === "Revoked") keys.set(key, { dead: null });
      break;
    }
    case "moderation.decide": {
      const item = str("item");
      const [k, th, sub] = item.split(":");
      const key =
        k === "f"
          ? `node:${sub}`
          : k === "r"
            ? `reply:${sub}`
            : k === "c"
              ? `comment:${sub}`
              : `thread:${th}`;
      const r = get(key) as StoredRecord & Fields;
      const d = input["decision"];
      if (d === "hidden" || d === "shown") {
        const mod = d === "hidden" ? "hidden" : null;
        keys.set(key, { mod, ...text(r) });
        // the answer of a hidden ask is hidden with it
        const answer = `answer:${String(r["id"])}`;
        if ((r.kind === "thread" || r.kind === "node") && dump.has(answer))
          keys.set(answer, { mod, md: (get(answer) as Fields)["md"] });
        break;
      }
      // removed: erased for good, with everything under it (owner decision,
      // 0b; `04` §6.2). The item stays as a placeholder with no text; the
      // removal is logged, and a thread's author is notified with the reason.
      const note = (typeof input["note"] === "string" ? input["note"] : "").trim() || null;
      const erased = new Set<string>([key]);
      const drop = (ck: string) => {
        erased.add(ck);
        keys.set(ck, null);
      };
      if (r.kind === "thread") {
        // nothing else of the removed content is kept (C12)
        keys.set(key, {
          mod: "removed",
          q: "",
          t: null,
          sum: null,
          tok: 0,
          src: 0,
          model: null,
          effort: null,
          edited: false,
          from: null,
          running: false,
          modBy: me,
          modNote: note,
        });
        keys.set(`counts:${r.id}`, { r: 0, saves: 0 });
        for (const [ck] of ofThread(r.id, "node", "answer", "reply", "comment", "run", "save"))
          drop(ck);
        for (const [ck, x] of dump)
          if (x.kind === "notif" && x.type === "mention" && x.th === r.id) keys.set(ck, null);
        notify(String(r.u), "removed", r.s, r.id, key, note);
      } else if (r.kind === "node") {
        keys.set(key, { mod: "removed", q: "", look: null, quote: null });
        if (dump.has(`answer:${r.id}`)) drop(`answer:${r.id}`);
        for (const [ck, x] of dump) if (x.kind === "comment" && x.node === r.id) drop(ck);
      } else if (r.kind === "reply" || r.kind === "comment") {
        keys.set(key, { mod: "removed", t: "" });
        if (r.parent === null)
          for (const [ck, x] of dump) if (x.kind === r.kind && x.parent === r.id) drop(ck);
        if (r.kind === "reply")
          keys.set(`counts:${r.th}`, { r: ofThread(r.th, "reply").length - (erased.size - 1) });
      }
      eraseMentions(erased);
      modlog(String(r["s"]), "remove", item, String(r["u"]), note);
      break;
    }
    case "notifications.markRead": {
      const key = `notif:${str("id")}`;
      if (get(key)?.["read"] === false) keys.set(key, { read: true });
      break;
    }
    case "notifications.markAllRead": {
      // the person's unread notifications they may read now
      for (const [k, r] of dump)
        if (r.kind === "notif" && r.to === me && !r.read && mayRead(dump, r, me))
          keys.set(k, { read: true });
      break;
    }
    case "prefs.set": {
      const old = get(`prefs:${me}`);
      if (old?.["layout"] !== input["layout"])
        keys.set(`prefs:${me}`, { u: me, layout: input["layout"] });
      break;
    }
  }
  return out;
}

/** The text fields of a moderated record, as they are: hiding or showing
 * keeps them. */
function text(r: StoredRecord): Fields {
  if (r.kind === "thread") return { q: r.q, t: r.t, sum: r.sum };
  if (r.kind === "node") return { q: r.q, look: r.look, quote: r.quote };
  if (r.kind === "reply" || r.kind === "comment") return { t: r.t };
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
    Object.entries(f).every(([k, v]) => {
      const got = (r as unknown as Fields)[k];
      return v instanceof Is ? v.test(got) : JSON.stringify(got) === JSON.stringify(v);
    });
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
