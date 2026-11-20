// The mockup's data as the real server's records (phase 2b): a Screen
// entry's scenario runs on the mockup's own backend (docs/mockups/
// session-web-spaces-{fixtures,jobs,mock-api,scenarios}.js, loaded here in a
// `vm` context), its collections are read as the mock serves them to the
// signed-in person (ines.v), and each becomes `@session/mutators` records.
// Fixture ids that are not ULIDs ("public", "rp1", "f0") get ULIDs at this
// boundary (report-2a finding 9): a fixed map from each fixture id to a ULID
// whose time is the mock clock's.
//
// The records are loaded with the test server's `POST /api/test/records`
// (`fresh: true`), so the client reads the same data the mockup shows.
//
// Answers: the mock keeps an answer as HTML with `<sup class="cite">N</sup>`
// markers and its cited pages apart; the server keeps Markdown in the
// thread's `sum` (a follow-up's `a`). The HTML becomes Markdown here, and a
// marker becomes a numbered link to its page (`[N](https://<domain>/… "Title")`).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const MOCKUPS = join(dirname(fileURLToPath(import.meta.url)), "../../../docs/mockups");

/** The signed-in person of the mockup. */
export const MOCK_ME = "ines.v";

type Json = Record<string, unknown>;
type Rec = Json & { kind: string };
export interface KeyedRecord {
  key: string;
  record: Rec;
}

// ---- ids ----

const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const EPOCH = Date.parse("2026-09-15T12:00:00Z");
const ids = new Map<string, string>();

/** A fixture id as a ULID (a ULID stays as it is). */
export function toUlid(x: string): string {
  if (ULID_RE.test(x)) return x;
  let u = ids.get(x);
  if (u) return u;
  let t = "";
  let ms = EPOCH;
  for (let i = 0; i < 10; i++, ms = Math.floor(ms / 32)) t = B32[ms % 32] + t;
  let h = 2166136261;
  let r = "";
  for (let i = 0; i < 16; i++) {
    for (const c of `${x}:${i}`) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
    r += B32[h % 32];
  }
  u = t + r;
  ids.set(x, u);
  return u;
}

// ---- the mock backend ----

interface Backend {
  get(path: string): Promise<unknown>;
  scenario(name: string, args?: unknown): Promise<void>;
  clock: string;
}

/** The mockup's backend in a fresh context, at its seed. */
export function mockBackend(): Backend {
  const store = new Map<string, string>();
  const win: Json = {
    fetch: () => Promise.reject(new Error("no network")),
    EventSource: class {},
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
    },
    location: { search: "", hash: "" },
    addEventListener() {},
    removeEventListener() {},
  };
  const ctx = vm.createContext({
    window: win,
    console: process.env["MOCK_DEBUG"] ? console : { ...console, error: () => undefined },
    setTimeout,
    clearTimeout,
    Response,
    Request,
    Headers,
    URL,
    URLSearchParams,
    structuredClone,
    Blob,
    EventTarget,
    Event,
    MessageEvent,
    AbortController,
    TextEncoder,
    TextDecoder,
    crypto,
    queueMicrotask,
    performance,
    localStorage: win["localStorage"],
    location: win["location"],
    EventSource: win["EventSource"],
  });
  ctx["self"] = win;
  for (const f of ["fixtures", "jobs", "mock-api", "scenarios"])
    vm.runInContext(readFileSync(join(MOCKUPS, `session-web-spaces-${f}.js`), "utf8"), ctx, {
      filename: `session-web-spaces-${f}.js`,
    });
  const api = win["SessionMockApi"] as {
    createBackend(o: Json): Json;
    dec(s: string): unknown;
  };
  const fixtures = win["SessionFixtures"] as { clock: string };
  api.createBackend({
    fixtures,
    scenarios: win["SessionScenarios"],
    latency: 0,
    jobMs: 1e9,
    checkMs: 1e9,
  });
  const fetch = win["fetch"] as typeof globalThis.fetch;
  return {
    clock: fixtures.clock,
    async get(path) {
      const r = await fetch(path);
      return r.ok ? api.dec(await r.text()) : undefined;
    },
    async scenario(name, args) {
      const r = await fetch("/api/dev/scenario", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(args ? { name, args } : { name }),
      });
      if (!r.ok) throw new Error(`scenario ${name}: ${r.status} ${await r.text()}`);
    },
  };
}

const ROWS: Record<string, string> = {
  spaces: "/api/spaces",
  posts: "/api/threads",
  rich: "/api/answers",
  srcd: "/api/answer-sources",
  fu: "/api/follow-ups",
  rp: "/api/replies",
  qtd: "/api/ask-trees",
  media: "/api/sources",
  joined: "/api/me/memberships",
  roles: "/api/me/roles",
  liked: "/api/me/likes",
  saved: "/api/me/saved",
  qtSaved: "/api/me/saved-asks",
  notifs: "/api/me/notifications",
  reqs: "/api/join-requests",
  mem: "/api/members",
  memOther: "/api/members/other-spaces",
  banned: "/api/bans",
  reports: "/api/reports",
  modSt: "/api/moderation",
  dsDrops: "/api/space-sources",
  dsPol: "/api/space-source-policies",
  profile: "/api/me/profile",
  skills: "/api/space-skills",
  pagedocs: "/api/pages",
  runs: "/api/runs",
  rpLiked: "/api/me/reply-likes",
  repSeen: "/api/me/report-notices",
  reqSeen: "/api/me/request-notices",
};

/** The mock's collections as it serves them to the signed-in person. */
export async function collections(b: Backend): Promise<Json> {
  const c: Json = {};
  for (const [k, path] of Object.entries(ROWS)) c[k] = await b.get(path);
  return c;
}

// ---- HTML answers as Markdown ----

const decode = (s: string) =>
  s
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");

const slug = (t: string) =>
  t
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** An answer's HTML as Markdown; `cites` are its cited pages ([title,
 * domain]) by number. */
export function htmlToMarkdown(html: string, cites: [string, string, string?][] = []): string {
  let s = html;
  s = s.replace(/<sup class="cite[^"]*">(\d+)<\/sup>/g, (_, n: string) => {
    const c = cites[Number(n) - 1];
    if (!c) return "";
    const [title, domain] = c;
    return `[${n}](https://${domain}/${slug(title)} "${title.replace(/"/g, "'")}")`;
  });
  s = s.replace(/<a [^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g, "[$2]($1)");
  s = s.replace(/<(b|strong)>([\s\S]*?)<\/\1>/g, "**$2**");
  s = s.replace(/<(i|em)>([\s\S]*?)<\/\1>/g, "*$2*");
  s = s.replace(/<code>([\s\S]*?)<\/code>/g, "`$1`");
  s = s.replace(/<h([1-6])>([\s\S]*?)<\/h\1>/g, (_, l: string, t: string) => `\n\n${"#".repeat(Number(l))} ${t}\n\n`);
  s = s.replace(/<blockquote>([\s\S]*?)<\/blockquote>/g, (_, t: string) => `\n\n> ${t.replace(/<\/?p>/g, "").trim()}\n\n`);
  s = s.replace(/<ol>([\s\S]*?)<\/ol>/g, (_, t: string) => {
    let n = 0;
    return `\n\n${t.replace(/<li>([\s\S]*?)<\/li>/g, (_m, x: string) => `${++n}. ${x.trim()}\n`)}\n`;
  });
  s = s.replace(/<ul>([\s\S]*?)<\/ul>/g, (_, t: string) => `\n\n${t.replace(/<li>([\s\S]*?)<\/li>/g, (_m, x: string) => `- ${x.trim()}\n`)}\n`);
  s = s.replace(/<br\s*\/?>/g, "  \n");
  s = s.replace(/<p>([\s\S]*?)<\/p>/g, "\n\n$1\n\n");
  s = s.replace(/<[^>]+>/g, "");
  return decode(s)
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/g, (m) => (m === "  " ? m : "")))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---- records ----

const ROLE: Record<string, string> = {
  Owner: "owner",
  Admin: "admin",
  Moderator: "mod",
  Member: "member",
  owner: "owner",
  admin: "admin",
  mod: "mod",
  member: "member",
};
const RANK: Record<string, number> = { member: 1, mod: 2, admin: 3, owner: 4 };
const pageSlug = (t: string) => slug(t);
/** A list the mock's codec decoded as a Set (of the mock's realm), an
 * array, or a `{ $set }` object, as an array. */
const unset = (s: unknown): string[] => {
  if (Array.isArray(s)) return s as string[];
  if (s && typeof s === "object") {
    if (typeof (s as { forEach?: unknown }).forEach === "function" && typeof (s as { has?: unknown }).has === "function")
      return Array.from(s as Iterable<string>);
    const x = (s as { $set?: unknown }).$set;
    if (Array.isArray(x)) return x as string[];
  }
  return [];
};

const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);
const num = (v: unknown, d = 0): number => (typeof v === "number" ? v : d);
const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});

/** The item key of a mock moderation key ("a:<thread>", "p:<thread>",
 * "r:<thread>:<reply>", "f:<thread>:<follow-up>"). */
function itemKey(key: string): string | null {
  const [k, th, sub] = key.split(":");
  if (!th) return null;
  if (k === "r" && sub) return `reply:${inThread(th, sub)}`;
  if (k === "f" && sub) return `followup:${inThread(th, sub)}`;
  return `thread:${th}`;
}

/** The ULID of an id the mock makes up within a thread ("f0", a reply's
 * "rp1"): fixture ids repeat across threads, so the thread is part of it. */
const inThread = (th: string, id: string) => (ULID_RE.test(id) ? id : toUlid(`${th}:${id}`));

/** The run record of an ask (`node` "r": the thread's; else a follow-up's):
 * every ask has one, so a replica holds the thread in full. */
function runOf(o: {
  th: string;
  s: string;
  u: string;
  node: string;
  running: boolean;
  fail: string | null;
  att: number;
  pay: string | null;
  model: string | null;
  executor: unknown;
  createdAt: string;
}): KeyedRecord {
  const id = toUlid(`run:${o.th}:${o.node}`);
  return {
    key: `run:${id}`,
    record: {
      kind: "run",
      id,
      th: o.th,
      s: o.s,
      u: o.u,
      node: o.node,
      status: o.running ? "running" : o.fail ? "failed" : "complete",
      end: o.running ? null : o.fail,
      attempt: o.att || 1,
      pay: o.pay,
      model: o.model,
      executor: o.executor ?? null,
      createdAt: o.createdAt,
    },
  };
}

/** The mock's collections as records, `me` the signed-in person. */
export function convert(c: Json, me: string, now: string): KeyedRecord[] {
  const at = now;
  const out = new Map<string, Rec>();
  const put = (key: string, record: Rec) => out.set(key, record);
  const members = new Map<string, Rec>();
  const member = (sp: string, u: string, role: string, joinedAt?: string) => {
    const k = `${sp}:${u}`;
    const old = members.get(k);
    if (old && (RANK[str(old["role"])] ?? 0) >= (RANK[role] ?? 0)) return;
    members.set(k, { kind: "member", sp, u, role, adm: toUlid(`adm:${k}`), joinedAt: joinedAt ?? at });
  };
  const joinedList = unset(c["joined"]);
  const joined = new Set(joinedList);
  // the person's spaces in the order they joined them (the mock lists them so)
  const joinedAt = (id: string) => {
    const k = joinedList.indexOf(id);
    return new Date(Date.parse("2026-09-20T12:00:00Z") + k * 3600_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  };
  const roles = obj(c["roles"]);
  const dsPol = obj(c["dsPol"]);
  // spaces, their stats, pages and members
  for (const s of arr<Json>(c["spaces"])) {
    const id = str(s["id"]);
    const sp = toUlid(id);
    const staff: [string, string][] = arr<[string, string]>(s["mods"]).map(([u, r]) => [u, ROLE[r] ?? "mod"]);
    const mine = joined.has(id) ? (ROLE[str(roles[id])] ?? "member") : null;
    if (mine && mine !== "member" && !staff.some(([u]) => u === me)) staff.push([me, mine]);
    staff.sort((a, b) => (RANK[b[1]] ?? 0) - (RANK[a[1]] ?? 0) || (a[0] < b[0] ? -1 : 1));
    // the person's own role is the mock's `roles`; the lists name others
    for (const [u, r] of staff) if (u !== me) member(sp, u, r);
    if (mine) member(sp, me, mine, joinedAt(id));
    const roster = id === "replication" ? c["mem"] : obj(c["memOther"])[id];
    for (const x of arr<Json>(roster))
      if (str(x["u"]) !== me) member(sp, str(x["u"]), ROLE[str(x["role"])] ?? "member", str(x["joinedAt"]) || undefined);
    const dom = obj(s["dom"]);
    put(`space:${sp}`, {
      kind: "space",
      id: sp,
      name: str(s["name"]),
      title: str(s["title"], str(s["name"])),
      desc: str(s["desc"]),
      rules: arr<string>(s["rules"]),
      rulesRev: num(s["rulesRev"]),
      rulesPrev: arr<string>(s["rulesPrev"]),
      rulesBy: str(s["rulesBy"]) || null,
      vis: str(s["vis"], "open"),
      policy: str(s["policy"]) || null,
      invite: str(s["invite"]) || null,
      qs: arr<Json>(s["qs"]).map((q) => ({ q: str(q["q"]), req: !!q["req"] })),
      postsOff: !!s["postsOff"],
      av: num(s["av"], 1),
      img: !!s["img"],
      faq: !!s["faq"],
      topics: arr(s["topics"]),
      plain: !!s["plain"],
      pageEdit: str(s["pageEdit"]) || null,
      srcPolicy: str(dsPol[id], "members") === "review" ? "review" : str(dsPol[id], "members") === "mods" ? "mods" : "members",
      dom: dom["domain"]
        ? { domain: str(dom["domain"]), method: "dns", state: str(dom["state"], "ok"), verifiedAt: str(dom["verifiedAt"]) || null }
        : null,
      archived: s["archived"] ? { by: str(obj(s["archived"])["by"], me), at: str(obj(s["archived"])["at"], at) } : null,
      deleted: !!s["deleted"],
      members: num(s["members"]),
      mods: staff,
      createdAt: str(s["createdAt"], at),
    });
    put(`stats:${sp}`, { kind: "stats", sp, posts: num(s["posts"]), updatedAt: str(s["updatedAt"], str(s["createdAt"], at)) });
    const pages = arr<[string, string, string]>(s["pages"]);
    put(`pages:${sp}`, { kind: "pages", sp, list: pages.map(([t, edited, pid]) => ({ id: toUlid(pid), t, at: edited })) });
    const docs = obj(c["pagedocs"]);
    for (const [t, edited, pid] of pages) {
      const doc = obj(Object.values(docs).find((d) => obj(d)["id"] === pid) ?? docs[`${id}/${pageSlug(t)}`]);
      const id2 = toUlid(pid);
      put(`page:${id2}`, {
        kind: "page",
        id: id2,
        sp,
        slug: pageSlug(t),
        t,
        text: arr<string>(doc["text"]),
        by: str(doc["by"]),
        ed: str(doc["ed"]) || null,
        ver: num(doc["rev"]),
        revs: arr<Json>(doc["revs"]).map((r) => ({ by: str(r["by"]), note: str(r["note"]), createdAt: str(r["createdAt"], edited) })),
      });
    }
    const skills = arr<Json>(obj(c["skills"])[id]);
    if (skills.length) {
      put(`skills:${sp}`, { kind: "skills", sp, order: skills.map((k) => toUlid(str(k["id"]))) });
      for (const k of skills) {
        const kid = toUlid(str(k["id"]));
        put(`skill:${kid}`, { kind: "skill", id: kid, sp, name: str(k["name"]), prompt: str(k["prompt"]), ver: num(k["rev"]) });
      }
    }
  }
  for (const x of members.values()) put(`member:${str(x["sp"])}:${str(x["u"])}`, x);
  // threads, answers, follow-ups and replies
  const rich = obj(c["rich"]);
  const srcd = obj(c["srcd"]);
  const fus = obj(c["fu"]);
  const qtd = obj(c["qtd"]);
  const modSt = obj(c["modSt"]);
  /** "<thread>:<mock node id>" → the follow-up's ULID. */
  const nodesOf = new Map<string, string>();
  const removed = (key: string) => modSt[key] === "removed";
  for (const p of arr<Json>(c["posts"])) {
    const th = str(p["id"]);
    const s = toUlid(str(p["s"]));
    const created = str(p["createdAt"], at);
    const cites = arr<[string, string, string]>(srcd[th]);
    const html = str(rich[th]);
    const ask = p["k"] === "ask";
    const fail = p["fail"] ? str(obj(p["fail"])["why"]) || "interrupted" : null;
    const sum = ask && !fail && !p["running"] ? (html ? htmlToMarkdown(html, cites) : str(p["sum"]) || null) : null;
    const fl = arr<Json>(fus[th]);
    const tree = arr<Json>(obj(qtd[th])["nodes"]);
    fl.forEach((f, k) => nodesOf.set(`${th}:${str(f["id"], `f${k}`)}`, inThread(th, str(f["id"], `f${k}`))));
    // follow-up ids: the mock's entry id, else its place
    const fuId = (k: number) => inThread(th, str(fl[k]?.["id"], `f${k}`));
    const nodeId = new Map<string, string>([["r", ""]]);
    tree.forEach((n) => {
      const nid = str(n["id"]);
      nodeId.set(nid, typeof n["fu"] === "number" ? fuId(n["fu"]) : inThread(th, nid));
      nodesOf.set(`${th}:${nid}`, nodeId.get(nid) ?? "");
    });
    put(`thread:${th}`, {
      kind: "thread",
      id: th,
      s,
      u: str(p["u"]),
      k: ask ? "ask" : "post",
      q: str(p["q"]),
      t: p["t"] == null ? null : str(p["t"]),
      sum: removed(`a:${th}`) ? null : sum,
      tok: num(p["tok"]),
      running: !!p["running"],
      edited: !!p["edited"],
      del: !!p["del"],
      gone: !!p["gone"],
      mod: removed(`${ask ? "a" : "p"}:${th}`) ? "removed" : null,
      topic: str(p["topic"]) || null,
      topicBy: str(p["topicBy"]) || null,
      pay: p["pay"] == null ? null : str(p["pay"]),
      model: str(p["model"]) || null,
      about: p["about"] ?? null,
      skill: str(p["skill"]) || null,
      att: num(p["att"], ask ? 1 : 0),
      from: p["from"] ? { th: str(obj(p["from"])["th"]), node: str(obj(p["from"])["node"]), lv: num(obj(p["from"])["lv"]) } : null,
      createdAt: created,
      updatedAt: str(p["updatedAt"], created),
    });
    const ex = obj(p["executor"]);
    if (ask) {
      const r = runOf({ th, s, u: str(p["u"]), node: "r", running: !!p["running"], fail, att: num(p["att"], 1), pay: p["pay"] == null ? null : str(p["pay"]), model: str(p["model"]) || null, executor: ex["kind"] ? { kind: "device", cli: str(ex["cli"], "claude"), device: toUlid(str(ex["device"], "d1")), u: str(ex["u"], me) } : null, createdAt: created });
      put(r.key, r.record);
    }
    const rps = arr<Json>(obj(c["rp"])[th]);
    const rlikes: Record<string, number> = {};
    put(`counts:${th}`, { kind: "counts", th, s, likes: num(p["likes"]), r: ask ? fl.length : rps.length, rlikes });
    fl.forEach((f, k) => {
      const id = fuId(k);
      put(`followup:${id}`, {
        kind: "followup",
        id,
        th,
        s,
        par: null,
        u: str(f["u"]),
        q: str(f["q"]),
        a: f["html"] ? htmlToMarkdown(str(f["html"])) : f["a"] == null ? null : str(f["a"]),
        uses: null,
        pay: f["pay"] == null ? null : str(f["pay"]),
        model: str(f["model"]) || null,
        att: 1,
        edited: !!f["edited"],
        del: !!f["del"],
        promoted: null,
        mod: null,
        createdAt: str(f["createdAt"], created),
      });
      const r = runOf({ th, s, u: str(f["u"]), node: id, running: !!f["running"], fail: null, att: 1, pay: f["pay"] == null ? null : str(f["pay"]), model: str(f["model"]) || null, executor: null, createdAt: str(f["createdAt"], created) });
      put(r.key, r.record);
    });
    for (const n of tree) {
      if (typeof n["fu"] === "number") continue;
      const id = nodeId.get(str(n["id"])) ?? inThread(th, str(n["id"]));
      const par = nodeId.get(str(n["par"], "r")) ?? "";
      put(`followup:${id}`, {
        kind: "followup",
        id,
        th,
        s,
        par: par || null,
        u: str(n["u"]),
        q: str(n["q"]),
        a: n["html"] ? htmlToMarkdown(str(n["html"])) : null,
        uses: null,
        pay: null,
        model: null,
        att: 1,
        edited: false,
        del: false,
        promoted: null,
        mod: null,
        createdAt: str(n["createdAt"], created),
      });
      const r = runOf({ th, s, u: str(n["u"]), node: id, running: !!n["running"], fail: null, att: 1, pay: n["pay"] == null ? null : str(n["pay"]), model: str(n["model"]) || null, executor: null, createdAt: str(n["createdAt"], created) });
      put(r.key, r.record);
    }
    rps.forEach((r, k) => {
      const rid = inThread(th, str(r["id"], `r${k}`));
      if (num(r["likes"])) rlikes[rid] = num(r["likes"]);
      put(`reply:${rid}`, { kind: "reply", id: rid, th, s, u: str(r["u"]), t: str(r["t"]), parent: null, edited: !!r["edited"], del: !!r["del"], mod: null, createdAt: str(r["createdAt"], created) });
      arr<Json>(r["kids"]).forEach((x, j) => {
        const xid = inThread(th, str(x["id"], `r${k}.${j}`));
        if (num(x["likes"])) rlikes[xid] = num(x["likes"]);
        put(`reply:${xid}`, { kind: "reply", id: xid, th, s, u: str(x["u"]), t: str(x["t"]), parent: rid, edited: !!x["edited"], del: !!x["del"], mod: null, createdAt: str(x["createdAt"], created) });
      });
    });
  }
  // hidden items
  for (const [key, state] of Object.entries(modSt)) {
    if (state !== "hidden") continue;
    const item = itemKey(key);
    const th = key.split(":")[1] ?? "";
    const t = out.get(`thread:${th}`);
    if (item && t) put(`hide:${item}`, { kind: "hide", item, s: str(t["s"]), ed: 0, createdAt: at });
  }
  // the person's records
  for (const th of unset(c["liked"])) if (out.has(`thread:${th}`)) put(`like:${me}:${th}`, { kind: "like", u: me, th, createdAt: at });
  for (const th of unset(c["saved"])) if (out.has(`thread:${th}`)) put(`save:${me}:${th}`, { kind: "save", u: me, th, createdAt: at });
  const profile = obj(c["profile"]);
  if (profile["name"]) put(`profile:${me}`, { kind: "profile", u: me, name: str(profile["name"]), bio: str(profile["bio"]) });
  put(`seen:${me}`, { kind: "seen", u: me, reqs: !!c["reqSeen"], reps: !!c["repSeen"] });
  for (const n of arr<Json>(c["notifs"])) {
    const id = toUlid(str(n["id"]));
    const th = str(n["thread"]) || null;
    const node = str(n["node"]) || null;
    put(`notif:${id}`, {
      kind: "notif",
      id,
      to: me,
      type: str(n["type"]),
      sp: n["space"] ? toUlid(str(n["space"])) : th && out.get(`thread:${th}`) ? str(out.get(`thread:${th}`)?.["s"]) : null,
      report: n["report"] ? toUlid(str(n["report"])) : null,
      item: n["item"] ? itemKey(str(n["item"])) : null,
      outcome: str(n["outcome"]) || null,
      response: str(n["response"]) || null,
      actor: str(n["actor"]) || null,
      thread: th,
      node: node && th ? (nodesOf.get(`${th}:${node}`) ?? inThread(th, node)) : null,
      invite: n["invite"] ? toUlid(str(n["invite"])) : null,
      read: !!n["read"],
      createdAt: str(n["createdAt"], at),
    });
  }
  for (const r of arr<Json>(c["reqs"])) {
    const sp = toUlid(str(r["sp"], "replication"));
    put(`request:${sp}:${str(r["u"])}`, { kind: "request", sp, u: str(r["u"]), st: str(r["st"], "open"), a: arr<string>(r["a"]), why: r["why"] == null ? null : str(r["why"]), createdAt: str(r["createdAt"], at), updatedAt: str(r["updatedAt"], str(r["createdAt"], at)) });
  }
  for (const r of arr<Json>(c["reports"])) {
    const id = toUlid(str(r["id"]));
    const key = itemKey(str(r["key"]));
    if (!key) continue;
    put(`report:${id}`, { kind: "report", id, sp: toUlid(str(r["sp"])), key, by: str(r["by"]), st: str(r["st"], "open"), why: str(r["why"]), note: str(r["note"]), createdAt: str(r["createdAt"], at), updatedAt: str(r["updatedAt"], str(r["createdAt"], at)) });
  }
  // sources added to spaces
  const media = new Map(arr<Json>(c["media"]).map((m) => [str(m["id"]), m]));
  for (const [sid, list] of Object.entries(obj(c["dsDrops"]))) {
    const sp = toUlid(sid);
    for (const d of arr<Json>(list)) {
      const m = media.get(str(d["m"]));
      if (!m) continue;
      const src = toUlid(str(m["id"]));
      put(`spacesrc:${sp}:${src}`, {
        kind: "spacesrc",
        sp,
        src,
        by: str(d["by"]),
        note: str(d["note"]),
        rv: !!d["rv"],
        rm: !!d["rm"],
        meta: {
          pl: str(m["pl"]),
          form: str(m["kind"]),
          au: str(m["au"]),
          h: str(m["h"]),
          len: str(m["len"]),
          tok: num(m["tok"]),
          url: str(m["url"]),
          t: m["t"] == null ? null : str(m["t"]),
          desc: str(m["desc"]),
          sum: str(m["sum"]),
          body: arr(m["body"]),
        },
        nurl: str(m["url"]) || null,
        createdAt: str(d["createdAt"], at),
      });
    }
  }
  return [...out].map(([key, record]) => ({ key, record }));
}

/** A scenario's records: the seed, then the scenario, as `me` reads them. */
export async function scenarioRecords(name = "seed", args?: unknown): Promise<{ records: KeyedRecord[]; clock: string }> {
  const b = mockBackend();
  if (name !== "seed") await b.scenario(name, args);
  const c = await collections(b);
  return { records: convert(c, MOCK_ME, b.clock), clock: b.clock };
}
