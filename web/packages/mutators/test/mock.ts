// The mock backend (`docs/mockups/session-web-spaces-*.js`) under Node, for
// the equivalence test. The mock is classic scripts that define globals on
// `window`; they run here with `window` as `globalThis` and stubs for
// `localStorage` and `EventSource` (as `@session/shared`'s spacesMock test
// does). Every call goes through the mock's own dispatcher (its `authorize`,
// `can`, `run` and transaction), with `fetch`, which the backend patches; its
// stored state is read back from the `localStorage` stub it saves to.
//
// The mock is single-user: its collections are one person's (`me`). This
// package's state is multi-user. `toMock` writes a multi-user store as the
// mock's collections for `me`; `projectOurs` and `projectMock` reduce both to
// the same shape, the state the mock stores, with ids made after the seed
// replaced by labels.

import type { MemoryStore, StoredRecord } from "../src/index.js";

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment,
   @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call,
   @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument --
   the mock is untyped JavaScript: its collections are read as `any` */
type Any = any;

const storage = new Map<string, string>();
const g = globalThis as Any;
g.window = globalThis;
g.localStorage = {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => void storage.set(k, v),
  removeItem: (k: string) => void storage.delete(k),
};
g.EventSource = function EventSource() {};
const load = (path: string) => import(path) as Promise<unknown>;
for (const name of ["fixtures", "jobs", "mock-api"])
  await load(`../../../../docs/mockups/session-web-spaces-${name}.js`);

export const M = g.SessionMockApi as {
  PROCEDURES: Record<string, unknown>;
  enc: (v: unknown) => string;
  dec: (s: string) => Any;
  createBackend: (o: Record<string, unknown>) => { wipe(): void; restore(): void };
};

/** The mock's person. */
export const ME = "me";
const STORAGE_KEY = "session-mock-db-v6";

let seed: Record<string, unknown> = {};
const backend = M.createBackend({ seed: () => M.dec(M.enc(seed)), latency: 0, dev: false });

export const restore = () => backend.restore();

async function request(
  method: string,
  url: string,
  body?: unknown,
): Promise<{ status: number; body: Any }> {
  const init =
    body === undefined ? { method, headers: {} } : { method, headers: {}, body: M.enc(body) };
  const res = (await g.fetch(url, init)) as { status: number; text(): Promise<string> };
  const text = await res.text();
  return { status: res.status, body: text ? M.dec(text) : null };
}

/** Start the mock over from `data` (its collections), at `now`. */
export async function reset(data: Record<string, unknown>, now: number) {
  seed = data;
  backend.wipe();
  await setNow(now);
}

export async function setNow(now: number) {
  const iso = new Date(now).toISOString().replace(/\.\d{3}Z$/, "Z");
  const r = await request("PUT", "/api/dev/config", { now: iso, jobs: "paused" });
  if (r.status !== 200) throw new Error(JSON.stringify(r.body));
}

/** Call a procedure as `me`: its result, or its error code. */
export async function call(
  name: string,
  input: unknown,
): Promise<{ ok: true; result: Any } | { ok: false; code: string; body: Any }> {
  const r = await request("POST", `/api/rpc/${name}`, input);
  if (r.status === 200) return { ok: true, result: r.body.result };
  return { ok: false, code: r.body.code, body: r.body };
}

/** The mock's stored collections now. */
export function stored(): Any {
  const s = storage.get(STORAGE_KEY);
  return s ? M.dec(s).data : M.dec(M.enc(seed));
}

// ---- our store as the mock's collections ----

const ROLE_NAME: Record<string, string> = { owner: "Owner", admin: "Admin", mod: "Moderator" };

const all = (s: MemoryStore) => [...s.records.values()];
const of = <K extends StoredRecord["kind"]>(s: MemoryStore, kind: K) =>
  all(s).filter((r): r is Extract<StoredRecord, { kind: K }> => r.kind === kind);
const byTime = <T extends { createdAt: string; id?: string }>(a: T, b: T) =>
  a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;

/** The mock's collections for `me`, from a multi-user store that holds only
 * the kinds this test seeds: spaces, members, threads with flat follow-ups
 * and replies, likes, saves, requests, bans, invite links, a catalog source,
 * notifications and the profile. */
export function toMock(s: MemoryStore): Record<string, unknown> {
  const members = of(s, "member");
  const mine = members.filter((m) => m.u === ME);
  const spaces = of(s, "space").map((x) => {
    const closed = x.vis !== "open";
    return {
      id: x.id,
      name: x.name,
      title: x.title,
      desc: x.desc,
      rules: x.rules,
      av: x.av,
      faq: x.faq,
      topics: x.topics,
      postsOff: x.postsOff,
      mods: x.mods,
      membersBase: 0,
      pages: [],
      createdAt: x.createdAt,
      ...(closed ? { vis: x.vis, policy: x.policy, invite: x.invite, qs: x.qs } : {}),
    };
  });
  const closedIds = new Set(
    of(s, "space")
      .filter((x) => x.vis !== "open")
      .map((x) => x.id),
  );
  const rel: Record<string, string> = {};
  for (const sp of closedIds) {
    const m = mine.find((x) => x.sp === sp);
    const r = s.get("request", `${sp}:${ME}`) as Any;
    rel[sp] = m
      ? m.role === "member"
        ? "member"
        : "mod"
      : r?.st === "open"
        ? "pending"
        : r?.st === "declined"
          ? "denied"
          : "none";
  }
  const roles = Object.fromEntries(
    mine.filter((m) => m.role !== "member").map((m) => [m.sp, ROLE_NAME[m.role]]),
  );
  const memOther: Record<string, unknown[]> = {};
  for (const m of members)
    (memOther[m.sp] ??= []).push({ u: m.u, role: m.role, joinedAt: m.joinedAt });
  const liked = new Set(
    of(s, "like")
      .filter((l) => l.u === ME)
      .map((l) => l.th),
  );
  const posts = of(s, "thread").map((p) => {
    const c = s.get("counts", p.id) as Any;
    return {
      id: p.id,
      s: p.s,
      u: p.u,
      k: p.k,
      q: p.q,
      t: p.t,
      sum: p.sum,
      tok: p.tok,
      running: p.running,
      topic: p.topic,
      topicBy: p.topicBy,
      ...(p.k === "ask" ? { att: p.att } : {}),
      likesBase: c.likes - (liked.has(p.id) ? 1 : 0),
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    };
  });
  const fu: Record<string, unknown[]> = {};
  for (const f of of(s, "followup").sort(byTime))
    (fu[f.th] ??= []).push({ u: f.u, q: f.q, a: f.a ?? "Researching…", createdAt: f.createdAt });
  const rp: Record<string, Any[]> = {};
  const replies = of(s, "reply").sort(byTime);
  for (const r of replies.filter((x) => x.parent === null))
    (rp[r.th] ??= []).push({
      u: r.u,
      t: r.t,
      createdAt: r.createdAt,
      kids: replies
        .filter((x) => x.parent === r.id)
        .map((x) => ({ u: x.u, t: x.t, createdAt: x.createdAt })),
    });
  return {
    spaces,
    posts,
    rich: {},
    srcd: {},
    fu,
    rp,
    qtd: {},
    media: of(s, "source").map((x) => ({
      id: x.id,
      pl: x.meta.pl,
      kind: x.meta.form,
      au: x.meta.au,
      h: x.meta.h,
      len: x.meta.len,
      tok: x.meta.tok,
      url: x.meta.url,
      sp: [],
      t: x.meta.t ?? undefined,
    })),
    miAdded: [],
    joined: mine.map((m) => m.sp),
    roles,
    roles0: { ...roles },
    rel,
    liked,
    saved: new Set(
      of(s, "save")
        .filter((x) => x.u === ME)
        .map((x) => x.th),
    ),
    qtSaved: new Set(),
    miSaved: new Set(),
    miRead: new Set(),
    userKeys: [],
    notifs: of(s, "notif")
      .filter((n) => n.to === ME)
      .map((n) => ({
        id: n.id,
        type: n.type,
        read: n.read,
        space: n.sp ?? undefined,
        createdAt: n.createdAt,
      })),
    askedInv: [],
    reqs: of(s, "request").map((r) => ({
      u: r.u,
      sp: r.sp,
      st: r.st,
      a: r.a,
      createdAt: r.createdAt,
      ...(r.why === null ? {} : { why: r.why }),
    })),
    mem: [],
    memOther,
    banned: of(s, "ban").map((b) => ({ id: b.id, sp: b.sp, u: b.u, createdAt: b.createdAt })),
    links: of(s, "invite").map((l) => ({
      id: l.id,
      code: l.code,
      by: l.by,
      sp: l.sp,
      expiresAt: l.expiresAt,
      createdAt: l.createdAt,
      ...(l.dead === null ? {} : { dead: l.dead }),
      ...(l.usedBy === null ? {} : { usedBy: l.usedBy }),
      ...(l.revokedAt === null ? {} : { revokedAt: l.revokedAt }),
    })),
    reports: [],
    modSt: {},
    dsDrops: {},
    dsPol: {},
    dsReps: [],
    profile: { name: "Me", bio: "" },
    skills: {},
    pagedocs: {},
    acct: {
      email: "me@example.org",
      emailNew: null,
      exportAt: null,
      emailOn: true,
      types: {},
      spaces: {},
    },
    muted: new Set(),
    blocked: new Set(),
    usage: { cap: 0, resetAt: "2026-12-01T00:00:00Z", def: null, movedSeen: false, by: {} },
    repSeen: false,
    reqSeen: false,
    rpLiked: new Set(),
    runs: {},
  };
}

// ---- projections ----

/** Ids made after the seed, by label, on each side. */
export class Labels {
  readonly ours = new Map<string, string>();
  readonly mock = new Map<string, string>();
  set(label: string, ours: string, mock: string) {
    this.ours.set(ours, label);
    this.mock.set(mock, label);
  }
  /** The label of an id, or the id (a seeded id is the same on both sides). */
  o = (id: string) => this.ours.get(id) ?? id;
  m = (id: string) => this.mock.get(id) ?? id;
  /** The id a label stands for on each side. */
  idOurs(label: string) {
    for (const [id, l] of this.ours) if (l === label) return id;
    return label;
  }
  idMock(label: string) {
    for (const [id, l] of this.mock) if (l === label) return id;
    return label;
  }
}

const sortBy = <T>(xs: T[], key: (x: T) => string) =>
  [...xs].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
const set = (xs: Iterable<string>) => [...xs].sort();

/** The shape both sides are compared in: what the mock stores for `me`. */
export interface Projection {
  spaces: Record<string, unknown>;
  joined: string[];
  rosters: Record<string, [string, string][]>;
  threads: Record<string, unknown>;
  followups: Record<string, unknown[]>;
  replies: Record<string, unknown[]>;
  requests: unknown[];
  bans: string[];
  links: Record<string, unknown>;
  reports: Record<string, unknown>;
  skills: Record<string, unknown>;
  pages: Record<string, string[]>;
  pagedocs: Record<string, unknown>;
  sources: Record<string, unknown[]>;
  sourceReports: unknown[];
  added: Record<string, unknown>;
  marks: Record<string, string[]>;
  notifs: Record<string, unknown>;
  profile: unknown;
  seen: unknown;
}

const spaceShape = (x: Any, members: number) => ({
  name: x.name,
  title: x.title,
  desc: x.desc,
  rules: x.rules ?? [],
  vis: x.vis ?? "open",
  policy: x.policy ?? null,
  invite: x.invite ?? null,
  qs: (x.qs ?? []).map((q: Any) => ({ q: q.q, req: q.req === true })),
  postsOff: x.postsOff === true,
  av: x.av,
  img: x.img === true,
  faq: x.faq === true,
  topics: x.topics ?? [],
  plain: x.plain === true,
  pageEdit: x.pageEdit ?? null,
  srcPolicy: x.srcPolicy,
  members,
  archived: Boolean(x.archived),
  deleted: x.deleted === true,
  dom: x.dom ? { domain: x.dom.domain, state: x.dom.state } : null,
});

/** The ask tree of a thread as the mock reads it: its stored tree, or its
 * flat follow-ups as first-level asks (the mock's `askTree`). */
function mockNodes(d: Any, th: string): Any[] {
  const fus = d.fu[th] ?? [];
  const tree = d.qtd[th] ?? {
    nodes: fus.map((_: unknown, k: number) => ({ id: "f" + k, par: "r", fu: k })),
  };
  return tree.nodes.map((n: Any) =>
    n.fu != null ? { ...n, ...fus[n.fu], id: n.id, par: n.par } : n,
  );
}

export function projectMock(d: Any, L: Labels): Projection {
  const roster = (sid: string): Any[] => d.memOther[sid] ?? [];
  const spaces: Record<string, unknown> = {};
  for (const s of d.spaces)
    spaces[L.m(s.id)] = spaceShape(
      { ...s, srcPolicy: d.dsPol[s.id] ?? "members" },
      (s.membersBase ?? 0) + roster(s.id).length,
    );
  const rosters: Record<string, [string, string][]> = {};
  for (const s of d.spaces)
    rosters[L.m(s.id)] = sortBy(
      roster(s.id).map((m: Any): [string, string] => [m.u, m.role]),
      (x) => x[0],
    );
  const threads: Record<string, unknown> = {};
  const followups: Record<string, unknown[]> = {};
  const replies: Record<string, unknown[]> = {};
  const mod = (k: string) => d.modSt[k] ?? null;
  for (const p of d.posts) {
    const nodes = mockNodes(d, p.id);
    const r = p.k === "ask" ? nodes.filter((n) => n.par === "r").length : (d.rp[p.id] ?? []).length;
    const liked = d.liked.has(p.id);
    threads[L.m(p.id)] = {
      s: L.m(p.s),
      u: p.u,
      k: p.k,
      q: p.q,
      t: p.t ?? null,
      sum: p.sum ?? null,
      del: p.del === true,
      gone: p.gone === true,
      edited: p.edited === true,
      running: p.running === true,
      topic: p.topic ?? null,
      topicBy: p.topicBy ?? null,
      att: p.att ?? 0,
      r,
      likes: (p.likesBase ?? 0) + (liked ? 1 : 0),
      liked,
      saved: d.saved.has(p.id),
      mod: mod(`${p.k === "ask" ? "a" : "p"}:${p.id}`),
    };
    if (nodes.length)
      followups[L.m(p.id)] = nodes.map((n) => ({
        u: n.u,
        q: n.q ?? "",
        del: n.del === true,
        edited: n.edited === true,
        par: n.par === "r" ? null : nodes.findIndex((x) => x.id === n.par),
      }));
    const rp = d.rp[p.id] ?? [];
    if (rp.length) {
      const shape = (x: Any): Any => ({
        u: x.u,
        t: x.t,
        del: x.del === true,
        edited: x.edited === true,
        kids: (x.kids ?? []).map(shape),
      });
      replies[L.m(p.id)] = rp.map(shape);
    }
  }
  const links: Record<string, unknown> = {};
  for (const l of d.links)
    links[L.m(l.id)] = {
      sp: L.m(l.sp),
      by: l.by,
      dead: l.dead ?? null,
      usedBy: l.usedBy ?? null,
      revoked: Boolean(l.revokedAt),
      expiresAt: l.expiresAt ?? null,
    };
  const reports: Record<string, unknown> = {};
  for (const r of d.reports)
    reports[L.m(r.id)] = {
      sp: L.m(r.sp),
      key: relabel(r.key, L.m),
      by: r.by,
      st: r.st,
      why: r.why ?? "",
      note: r.note ?? "",
    };
  const skills: Record<string, unknown> = {};
  for (const [sid, l] of Object.entries(d.skills as Record<string, Any[]>))
    if (l.length) skills[L.m(sid)] = l.map((x) => ({ name: x.name, prompt: x.prompt, rev: x.rev }));
  const pages: Record<string, string[]> = {};
  for (const s of d.spaces)
    if ((s.pages ?? []).length) pages[L.m(s.id)] = s.pages.map((p: Any) => p[0]);
  const pagedocs: Record<string, unknown> = {};
  for (const [key, doc] of Object.entries(d.pagedocs as Record<string, Any>)) {
    const [sid, slug] = key.split("/");
    pagedocs[`${L.m(sid ?? "")}/${slug}`] = {
      t: doc.t,
      text: doc.text,
      by: doc.by,
      ed: doc.ed ?? null,
      ver: doc.rev ?? 0,
      notes: doc.revs.map((r: Any) => `${r.by}: ${r.note}`),
    };
  }
  const sources: Record<string, unknown[]> = {};
  for (const [sid, l] of Object.entries(d.dsDrops as Record<string, Any[]>))
    if (l.length)
      sources[L.m(sid)] = sortBy(
        l.map((x) => ({
          m: L.m(x.m),
          by: x.by,
          note: x.note ?? "",
          rv: x.rv === true,
          rm: x.rm === true,
        })),
        (x) => x.m,
      );
  const added: Record<string, unknown> = {};
  for (const x of d.miAdded)
    added[L.m(x.id)] = {
      pl: x.pl,
      form: x.kind,
      au: x.au,
      h: x.h,
      len: x.len,
      tok: x.tok,
      url: x.url,
      t: x.t ?? null,
    };
  const rpPath = (key: string) => {
    const [th, path] = key.split(":");
    return `${L.m(th ?? "")}:${path}`;
  };
  const notifs: Record<string, unknown> = {};
  // a resolution's notice is the server's post-commit effect here (D3)
  for (const n of d.notifs)
    if (n.type !== "report_resolved")
      notifs[L.m(n.id)] = { type: n.type, read: n.read, response: n.response ?? null };
  return {
    spaces,
    joined: set(d.joined.map(L.m)),
    rosters,
    threads,
    followups,
    replies,
    requests: sortBy(
      d.reqs.map((r: Any) => ({ u: r.u, sp: L.m(r.sp), st: r.st, why: r.why ?? null })),
      (x: Any) => `${x.u}:${x.sp}`,
    ),
    bans: set(d.banned.map((b: Any) => `${L.m(b.sp)}:${b.u}`)),
    links,
    reports,
    skills,
    pages,
    pagedocs,
    sources,
    sourceReports: sortBy(
      d.dsReps.map((x: Any) => ({ m: L.m(x.m), sp: L.m(x.sid), by: x.by, why: x.why })),
      (x: Any) => `${x.sp}:${x.m}:${x.by}`,
    ),
    added,
    marks: {
      qtSaved: set([...d.qtSaved].map((k: string) => relabelNode(k, L.m, d))),
      miSaved: set([...d.miSaved].map(L.m)),
      miRead: set([...d.miRead].map(L.m)),
      muted: set(d.muted),
      blocked: set(d.blocked),
      askedInv: set(d.askedInv.map(L.m)),
      rpLiked: set([...d.rpLiked].map(rpPath)),
    },
    notifs,
    profile: d.profile,
    seen: { reqs: d.reqSeen, reps: d.repSeen },
  };
}

/** A moderation key with its thread id labelled. */
function relabel(key: string, l: (id: string) => string): string {
  const [k, th, ...rest] = key.split(":");
  return [k, l(th ?? ""), ...rest].join(":");
}

/** A saved ask's key "<thread>:<node>" with its node as an index in the
 * thread's ask tree ("r" for the thread's ask). */
function relabelNode(key: string, l: (id: string) => string, d: Any): string {
  const [th = "", node = ""] = key.split(":");
  if (node === "r") return `${l(th)}:r`;
  return `${l(th)}:${mockNodes(d, th).findIndex((n) => n.id === node)}`;
}

export function projectOurs(s: MemoryStore, L: Labels): Projection {
  const spaces: Record<string, unknown> = {};
  const rosters: Record<string, [string, string][]> = {};
  for (const x of of(s, "space")) {
    spaces[L.o(x.id)] = spaceShape(x, x.members);
    rosters[L.o(x.id)] = sortBy(
      of(s, "member")
        .filter((m) => m.sp === x.id)
        .map((m): [string, string] => [m.u, m.role]),
      (y) => y[0],
    );
  }
  const threads: Record<string, unknown> = {};
  const followups: Record<string, unknown[]> = {};
  const replies: Record<string, unknown[]> = {};
  const nodesOf = (th: string) =>
    of(s, "followup")
      .filter((f) => f.th === th)
      .sort(byTime);
  for (const p of of(s, "thread")) {
    const c = s.get("counts", p.id) as Any;
    threads[L.o(p.id)] = {
      s: L.o(p.s),
      u: p.u,
      k: p.k,
      q: p.q,
      t: p.t,
      sum: p.sum,
      del: p.del,
      gone: p.gone,
      edited: p.edited,
      running: p.running,
      topic: p.topic,
      topicBy: p.topicBy,
      att: p.att,
      r: c?.r ?? 0,
      likes: c?.likes ?? 0,
      liked: s.get("like", `${ME}:${p.id}`) !== undefined,
      saved: s.get("save", `${ME}:${p.id}`) !== undefined,
      mod: p.mod,
    };
    const nodes = nodesOf(p.id);
    if (nodes.length)
      followups[L.o(p.id)] = nodes.map((n) => ({
        u: n.u,
        q: n.q,
        del: n.del,
        edited: n.edited,
        par: n.par === null ? null : nodes.findIndex((x) => x.id === n.par),
      }));
    const rs = of(s, "reply")
      .filter((r) => r.th === p.id)
      .sort(byTime);
    const shape = (x: Extract<StoredRecord, { kind: "reply" }>): Any => ({
      u: x.u,
      t: x.t,
      del: x.del,
      edited: x.edited,
      kids: rs.filter((y) => y.parent === x.id).map(shape),
    });
    const top = rs.filter((r) => r.parent === null);
    if (top.length) replies[L.o(p.id)] = top.map(shape);
  }
  const replyPath = (id: string) => {
    const r = s.get("reply", id) as Any;
    const rs = of(s, "reply")
      .filter((x) => x.th === r.th)
      .sort(byTime);
    const top = rs.filter((x) => x.parent === null);
    if (r.parent === null) return `${L.o(r.th)}:${top.findIndex((x) => x.id === id)}`;
    const kids = rs.filter((x) => x.parent === r.parent);
    return `${L.o(r.th)}:${top.findIndex((x) => x.id === r.parent)}.${kids.findIndex((x) => x.id === id)}`;
  };
  const links: Record<string, unknown> = {};
  for (const l of of(s, "invite"))
    links[L.o(l.id)] = {
      sp: L.o(l.sp),
      by: l.by,
      dead: l.dead,
      usedBy: l.usedBy,
      revoked: l.revokedAt !== null,
      expiresAt: l.expiresAt,
    };
  const reports: Record<string, unknown> = {};
  for (const r of of(s, "report"))
    reports[L.o(r.id)] = {
      sp: L.o(r.sp),
      key: relabel(r.key, L.o),
      by: r.by,
      st: r.st,
      why: r.why,
      note: r.note,
    };
  const skills: Record<string, unknown> = {};
  for (const x of of(s, "skills")) if (x.list.length) skills[L.o(x.sp)] = x.list;
  const pages: Record<string, string[]> = {};
  for (const x of of(s, "pages")) if (x.list.length) pages[L.o(x.sp)] = x.list.map((p) => p[0]);
  const pagedocs: Record<string, unknown> = {};
  for (const x of of(s, "page"))
    pagedocs[`${L.o(x.sp)}/${x.slug}`] = {
      t: x.t,
      text: x.text,
      by: x.by,
      ed: x.ed,
      ver: x.ver,
      notes: x.revs.map((r) => `${r.by}: ${r.note}`),
    };
  const sources: Record<string, unknown[]> = {};
  const added: Record<string, unknown> = {};
  for (const x of of(s, "spacesrc")) {
    (sources[L.o(x.sp)] ??= []).push({ m: L.o(x.src), by: x.by, note: x.note, rv: x.rv, rm: x.rm });
    if (!s.get("source", x.src))
      added[L.o(x.src)] = { ...x.meta, desc: undefined, sum: undefined, body: undefined };
  }
  for (const k of Object.keys(sources)) sources[k] = sortBy(sources[k] as Any[], (x: Any) => x.m);
  for (const k of Object.keys(added)) added[k] = JSON.parse(JSON.stringify(added[k]));
  const mine = <K extends StoredRecord["kind"]>(kind: K) =>
    of(s, kind).filter((x) => "u" in x && x.u === ME);
  const notifs: Record<string, unknown> = {};
  for (const n of of(s, "notif"))
    if (n.to === ME && n.type !== "report_resolved")
      notifs[L.o(n.id)] = { type: n.type, read: n.read, response: n.response };
  const seen = s.get("seen", ME) as Any;
  const profile = s.get("profile", ME) as Any;
  return {
    spaces,
    joined: set(
      of(s, "member")
        .filter((m) => m.u === ME)
        .map((m) => L.o(m.sp)),
    ),
    rosters,
    threads,
    followups,
    replies,
    requests: sortBy(
      of(s, "request").map((r) => ({ u: r.u, sp: L.o(r.sp), st: r.st, why: r.why })),
      (x) => `${x.u}:${x.sp}`,
    ),
    bans: set(of(s, "ban").map((b) => `${L.o(b.sp)}:${b.u}`)),
    links,
    reports,
    skills,
    pages,
    pagedocs,
    sources,
    sourceReports: sortBy(
      of(s, "srcrep").map((x) => ({ m: L.o(x.src), sp: L.o(x.sp), by: x.by, why: x.why })),
      (x) => `${x.sp}:${x.m}:${x.by}`,
    ),
    added,
    marks: {
      qtSaved: set(
        mine("asksave").map((x) => {
          const n = x.node === "r" ? "r" : String(nodesOf(x.th).findIndex((f) => f.id === x.node));
          return `${L.o(x.th)}:${n}`;
        }),
      ),
      miSaved: set(mine("srcsave").map((x) => L.o(x.src))),
      miRead: set(mine("srcread").map((x) => L.o(x.src))),
      muted: set(mine("mute").map((x) => x.who)),
      blocked: set(mine("block").map((x) => x.who)),
      askedInv: set(mine("invask").map((x) => L.o(x.sp))),
      rpLiked: set(mine("rlike").map((x) => replyPath(x.reply))),
    },
    notifs,
    profile: profile ? { name: profile.name, bio: profile.bio } : { name: "Me", bio: "" },
    seen: { reqs: seen?.reqs ?? false, reps: seen?.reps ?? false },
  };
}
