// The members mockup's fixtures in the stored shape (02 §9.6): a pure
// conversion of `window.SessionFixtures` (docs/mockups/
// session-web-spaces-fixtures.js) plus the mockup's own seeds
// (`session-web-members.html`: owners and visibility, joined channels, the
// typed prompts, the seeded removals, the post by @ines.v, notifications,
// usage) into records of `@session/shared`'s contract.
//
// What changes on the way, as 02 §9.7 says:
// - answers are Markdown, converted from the fixtures' HTML; a citation
//   `<sup class="cite">N</sup>` becomes `[^N]`;
// - a branch's passage index `b` is computed here once, with the mock's word
//   overlap (`bestBlock`), and stored; the client never matches words;
// - questions are stored as typed (`PROMPTS`), titles as the fixtures'
//   `t`;
// - save and member counts are records: the mock's `likesBase` and member
//   counts are made up of save and member records of placeholder accounts
//   (`reader-N`), so a save or a join recounts correctly;
// - ids are ULIDs: fixture ids that are not (spaces, nodes, replies) get a
//   deterministic one from their creation time and a hash of the fixture id;
// - the older mock's reference threads (`rf`, kept out of Home by the mock)
//   and the channel without an owner (`sablefield`) are left out;
// - a removed thread keeps no text (01 C12), and nothing under it.

import { hash128, isoToMs, msToIso, type Draft, type StoredRecord } from "@session/mutators";

import { passageUnits } from "./answerText.js";
import { PROMPTS } from "./fixturePrompts.js";
import { ulidTimePart } from "./ulid.js";

// ---- the fixtures file's shape (only what is read) ----

interface FixturePost {
  id: string;
  s: string;
  u: string;
  k: "ask" | "post";
  createdAt: string;
  t?: string;
  q: string;
  sum?: string;
  tok?: number;
  likesBase?: number;
  rf?: string;
}
interface FixtureFollowUp {
  u: string;
  createdAt: string;
  q: string;
  a?: string;
  html?: string;
}
interface FixtureNode {
  id: string;
  par: string;
  fu?: number;
  tok?: number;
  u?: string;
  createdAt?: string;
  q?: string;
  html?: string;
}
interface FixtureReply {
  u: string;
  createdAt: string;
  t: string;
  kids?: FixtureReply[];
}
export interface SessionFixtures {
  clock: string;
  data: {
    spaces: { id: string; name: string; desc?: string; createdAt: string }[];
    posts: FixturePost[];
    rich: Record<string, string>;
    srcd: Record<string, [string, string, string][]>;
    fu: Record<string, FixtureFollowUp[]>;
    rp: Record<string, FixtureReply[]>;
    qtd: Record<string, { nodes: FixtureNode[] }>;
    saved: { $set: string[] };
    banned: { sp: string; u: string; createdAt: string }[];
  };
}

// ---- the mockup's seeds (session-web-members.html) ----

const SPACE_META: Record<string, { owner: string; vis?: "private" }> = {
  public: { owner: "sol" },
  scifi: { owner: "ines.v" },
  markets: { owner: "hal_b" },
  ml: { owner: "jun.park" },
  bio: { owner: "mira_k" },
  history: { owner: "tomasz" },
  climate: { owner: "oduya" },
  urbanism: { owner: "lettie" },
  math: { owner: "jun.park" },
  replication: { owner: "mira_k" },
  northwind: { owner: "hal_b", vis: "private" },
  grants: { owner: "sol", vis: "private" },
  ward7: { owner: "lettie", vis: "private" },
};

const JOINED: Record<string, string[]> = {
  "ines.v": ["public", "scifi", "markets", "ml", "urbanism", "replication", "grants"],
  sol: Object.keys(SPACE_META),
  hal_b: ["public", "markets", "northwind", "scifi"],
  "kofi.a": ["public", "scifi"],
};

/** Session accounts of the mock (`MEMBERS`): who a mention can reach. */
export const FIXTURE_ACCOUNTS: ReadonlySet<string> = new Set([
  "sol",
  "hal_b",
  "ines.v",
  "tomasz",
  "oduya",
  "mira_k",
  "jun.park",
  "lettie",
  "priya.n",
  "kofi.a",
  "dmitri_k",
]);

/** The handle a signed-in account reads the fixtures as: a member as the
 * mock's default persona, an account without an invite as its waiting one. */
export const FIXTURE_MEMBER = "ines.v";
export const FIXTURE_WAITING = "kofi.a";

const RUNS: [string, "low" | "medium" | "high" | "max"][] = [
  ["claude-fable", "high"],
  ["claude-fable", "medium"],
  ["gemini-flash", "high"],
  ["claude-fable", "max"],
];

const SEED_RM: FixturePost = {
  id: "01M7GZF0R0SEEDRM00000000RM",
  s: "scifi",
  u: "dmitri_k",
  k: "post",
  createdAt: "2026-11-15T09:00:00Z",
  q: "",
};
const SEED_RM_NOTE = "Sales posts are off topic here.";
const RM_ASK = "01M7H6F3P012CRWKEQVTVA6PV4";
const RM_ASK_NOTE = "Duplicate of the Nov 12 thread on the same paper. Please continue there.";
const SEED_POST: FixturePost = {
  id: "01M7GNRKE0SEEDP0ST00000000",
  s: "ml",
  u: "ines.v",
  k: "post",
  createdAt: "2026-11-15T17:40:00Z",
  q: "Collecting test-time compute results outside math and code. I have three papers so far; add any you know of.",
  likesBase: 4,
};
const SEED_POST_REPLIES: FixtureReply[] = [
  {
    u: "lettie",
    createdAt: "2026-11-15T21:05:00Z",
    t: "The agent-benchmark paper from October has a section on this, for web tasks.",
  },
  {
    u: "jun.park",
    createdAt: "2026-11-16T08:12:00Z",
    t: "Two more from the planning literature. @ines.v the second one has released code.",
  },
];
const SEED_COMMENT = {
  thread: "01M7H6F3P02JFX3X2X804X3986",
  u: "mira_k",
  createdAt: "2026-11-15T20:10:00Z",
  t: "The 1964 World’s Fair Picturephone demo is the clearest case of this; worth adding.",
};

/** The mock's weekly usage of @ines.v (`USAGE`) and the reset (`RESET`). */
export const FIXTURE_USAGE = {
  used: 1_240_000,
  allowance: 2_000_000,
  resetsAt: "2026-11-20T00:00:00Z",
};

// ---- helpers ----

const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A deterministic ULID for a fixture item: its time and a hash of `seed`. */
export function fixtureUlid(seed: string, iso: string): string {
  const [a = 0, b = 0, c = 0] = hash128(seed);
  let n = (BigInt(a) << 48n) | (BigInt(b) << 16n) | BigInt(c >>> 16);
  let r = "";
  for (let i = 0; i < 16; i++) {
    r = B32.charAt(Number(n & 31n)) + r;
    n >>= 5n;
  }
  return ulidTimePart(isoToMs(iso)) + r;
}

const STOP = new Set(
  "what which does with that this from have there their about would could should into than then they them were been being where when your more most other some such only also over just like very many much does show give list same each these those here after before because between under while whether".split(
    " ",
  ),
);
const stripHtml = (h: string) =>
  h
    .replace(/<sup[^>]*>.*?<\/sup>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const words = (s: string) =>
  new Set(
    (
      stripHtml(s)
        .toLowerCase()
        .match(/[a-z0-9]{4,}/g) ?? []
    ).filter((w) => !STOP.has(w)),
  );
function overlap(w: Set<string>, text: string): number {
  const bw = words(text);
  let score = 0;
  w.forEach((x) => {
    if (bw.has(x)) score++;
  });
  return score / Math.sqrt(bw.size + 6);
}
const clip = (s: string, n: number) =>
  s.length > n ? `${s.slice(0, n - 1).replace(/[\s,;:.]+\S*$/, "")}…` : s;

/** The passage a branch asks about (`bestBlock`): the unit sharing the most
 * words with its question and answer; headings never. */
function bestPassage(units: Element[], text: string): number {
  const w = words(text);
  let best = 0;
  let index = 0;
  units.forEach((unit, i) => {
    if (/^H\d$/.test(unit.tagName)) return;
    const score = overlap(w, unit.textContent ?? "");
    if (score > best) {
      best = score;
      index = i;
    }
  });
  return index;
}

// ---- HTML to Markdown ----

function escapeText(text: string, inTable: boolean): string {
  let out = text.replace(/[\\`*_[\]<>]/g, (c) => `\\${c}`);
  if (inTable) out = out.replace(/\|/g, "\\|");
  return out;
}

function inline(node: Node, inTable = false): string {
  if (node.nodeType === 3)
    return escapeText((node.textContent ?? "").replace(/\s+/g, " "), inTable);
  if (node.nodeType !== 1) return "";
  const el = node as Element;
  const inner = () => Array.from(el.childNodes, (c) => inline(c, inTable)).join("");
  switch (el.tagName) {
    case "SUP": {
      const n = (el.textContent ?? "").trim();
      return /^\d+$/.test(n) ? `[^${n}]` : inner();
    }
    case "I":
    case "EM":
      return `*${inner().trim()}*`;
    case "B":
    case "STRONG":
      return `**${inner().trim()}**`;
    case "CODE":
      return `\`${el.textContent ?? ""}\``;
    case "A":
      return `[${inner()}](${el.getAttribute("href") ?? ""})`;
    case "BR":
      return " ";
    default:
      return inner();
  }
}

/** A paragraph's text, guarded so it cannot start a list, heading or quote. */
function blockText(el: Element): string {
  return inline(el)
    .trim()
    .replace(/^(\d+)\.(\s)/, "$1\\.$2")
    .replace(/^([-+#>])/, "\\$1");
}

export function htmlToMarkdown(html: string, doc: Document): string {
  const root = doc.createElement("div");
  root.innerHTML = html;
  const blocks: string[] = [];
  for (const el of Array.from(root.children)) {
    switch (el.tagName) {
      case "UL":
      case "OL": {
        const ordered = el.tagName === "OL";
        blocks.push(
          Array.from(el.children)
            .filter((li) => li.tagName === "LI")
            .map((li, i) => `${ordered ? `${i + 1}.` : "-"} ${blockText(li)}`)
            .join("\n"),
        );
        break;
      }
      case "TABLE": {
        const rows = Array.from(el.querySelectorAll("tr"));
        const cells = rows.map((tr) =>
          Array.from(tr.children, (cell) => inline(cell, true).trim()),
        );
        const width = Math.max(...cells.map((r) => r.length));
        const line = (r: string[]) =>
          `| ${Array.from({ length: width }, (_, i) => r[i] ?? "").join(" | ")} |`;
        const [head = [], ...body] = cells;
        blocks.push([line(head), `|${" --- |".repeat(width)}`, ...body.map(line)].join("\n"));
        break;
      }
      case "PRE":
        blocks.push(`\`\`\`\n${(el.textContent ?? "").replace(/\n$/, "")}\n\`\`\``);
        break;
      case "H1":
      case "H2":
      case "H3":
      case "H4":
      case "H5":
      case "H6":
        blocks.push(`${"#".repeat(Number(el.tagName.slice(1)))} ${inline(el).trim()}`);
        break;
      default:
        blocks.push(blockText(el));
    }
  }
  return blocks.filter(Boolean).join("\n\n");
}

/** The units of an answer as the client renders it, from its HTML. */
function unitsOf(html: string, doc: Document): Element[] {
  const root = doc.createElement("div");
  root.innerHTML = html;
  return passageUnits(root);
}

// ---- conversion ----

export interface FixtureWorld {
  records: StoredRecord[];
  /** The fixtures' clock (`clock`), in ms. */
  clock: number;
  /** Fixture ids of channels → their ULIDs. */
  spaceIds: Record<string, string>;
}

const esc = (s: string) =>
  s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] ?? c);

export function convertFixtures(F: SessionFixtures, doc: Document): FixtureWorld {
  const D = F.data;
  const out: Draft[] = [];
  const put = (r: Draft) => out.push(r);
  const spaceIds: Record<string, string> = {};
  const hashN = (id: string, n: number) =>
    [...id].reduce((a, c) => a + (c.codePointAt(0) ?? 0), 0) % n;

  // channels, with their owners and members; a second apart, so the strip
  // lists them in the fixtures' order
  let order = 0;
  for (const s of D.spaces) {
    const meta = SPACE_META[s.id];
    if (!meta) continue;
    const createdAt = msToIso(isoToMs(s.createdAt) + order++ * 1000);
    const id = fixtureUlid(`space:${s.id}`, s.createdAt);
    spaceIds[s.id] = id;
    const known = new Set<string>([meta.owner]);
    for (const [u, list] of Object.entries(JOINED)) if (list.includes(s.id)) known.add(u);
    const total = Math.max(known.size, 4 + hashN(s.id, 60));
    const members = [...known];
    for (let i = 1; members.length < total; i++) members.push(`reader-${i}`);
    put({
      kind: "space",
      id,
      name: s.name,
      desc: s.desc ?? "",
      vis: meta.vis ?? "open",
      members: members.length,
      owner: meta.owner,
      frozen: false,
      createdAt,
    });
    members.forEach((u, i) =>
      put({
        kind: "member",
        sp: id,
        u,
        role: u === meta.owner ? "owner" : "member",
        adm: fixtureUlid(`adm:${s.id}:${u}`, s.createdAt),
        joinedAt: msToIso(isoToMs(s.createdAt) + i * 60_000),
      }),
    );
  }

  const posts = [
    ...D.posts.filter((p) => !p.rf && spaceIds[p.s] !== undefined),
    SEED_RM,
    SEED_POST,
  ];
  const saved = new Set(D.saved.$set);
  const posted = new Map<string, { n: number; at: string }>();

  for (const p of posts) {
    const s = spaceIds[p.s];
    if (!s) continue;
    const stat = posted.get(s) ?? { n: 0, at: "" };
    posted.set(s, { n: stat.n + 1, at: p.createdAt > stat.at ? p.createdAt : stat.at });
    const prompts = PROMPTS[p.id] ?? {};
    const typed = (key: string, text: string) => prompts[key] ?? text;
    const hash = [...p.id].reduce((a, c) => a + (c.codePointAt(0) ?? 0), 0);
    const [model, effort] = RUNS[hash % RUNS.length] ?? RUNS[0]!;
    const removed = p.id === SEED_RM.id || p.id === RM_ASK;
    const base = {
      kind: "thread" as const,
      id: p.id,
      s,
      u: p.u,
      k: p.k,
      running: false,
      edited: false,
      del: false,
      gone: false,
      from: null,
      createdAt: p.createdAt,
      updatedAt: p.createdAt,
    };
    if (removed) {
      put({
        ...base,
        q: "",
        t: null,
        sum: null,
        tok: 0,
        src: 0,
        model: null,
        effort: null,
        mod: "removed",
        modBy: p.id === RM_ASK ? "mira_k" : "ines.v",
        modNote: p.id === RM_ASK ? RM_ASK_NOTE : SEED_RM_NOTE,
      });
      put({ kind: "counts", th: p.id, s, saves: 0, r: 0 });
      put({
        kind: "modlog",
        id: fixtureUlid(`modlog:${p.id}`, p.createdAt),
        sp: s,
        act: "remove",
        item: `${p.k === "ask" ? "a" : "p"}:${p.id}`,
        by: p.id === RM_ASK ? "mira_k" : "ines.v",
        author: p.u,
        note: p.id === RM_ASK ? RM_ASK_NOTE : SEED_RM_NOTE,
        createdAt:
          p.id === RM_ASK ? msToIso(isoToMs(F.clock) - 3 * 3_600_000) : "2026-11-15T11:20:00Z",
      });
      continue;
    }

    // saves: the viewer's, and placeholder readers for the mock's count
    const saves = (p.likesBase ?? 0) + (saved.has(p.id) ? 1 : 0);
    const savers = saved.has(p.id) ? [FIXTURE_MEMBER] : [];
    for (let i = 1; savers.length < saves; i++) savers.push(`reader-${i}`);
    for (const u of savers) put({ kind: "save", u, th: p.id, createdAt: p.createdAt });
    const pages = D.srcd[p.id] ?? [];

    if (p.k === "post") {
      const q = p.q;
      const list = p.id === SEED_POST.id ? SEED_POST_REPLIES : (D.rp[p.id] ?? []);
      let count = 0;
      list.forEach((r, i) => {
        const id = fixtureUlid(`reply:${p.id}:${i}`, r.createdAt);
        count++;
        put({
          kind: "reply",
          id,
          th: p.id,
          s,
          u: r.u,
          t: r.t,
          parent: null,
          edited: false,
          del: false,
          mod: null,
          createdAt: r.createdAt,
        });
        (r.kids ?? []).forEach((k, j) => {
          count++;
          put({
            kind: "reply",
            id: fixtureUlid(`reply:${p.id}:${i}.${j}`, k.createdAt),
            th: p.id,
            s,
            u: k.u,
            t: k.t,
            parent: id,
            edited: false,
            del: false,
            mod: null,
            createdAt: k.createdAt,
          });
        });
      });
      put({
        ...base,
        q,
        t: p.t ?? null,
        sum: null,
        tok: 0,
        src: 0,
        model: null,
        effort: null,
        mod: null,
        modBy: null,
        modNote: null,
      });
      put({ kind: "counts", th: p.id, s, saves, r: count });
      continue;
    }

    // an ask: the thread, its root run and answer, then its branches
    const rootHtml = D.rich[p.id] ?? (p.sum ? `<p>${esc(p.sum)}</p>` : "");
    const rootRun = fixtureUlid(`run:${p.id}:r`, p.createdAt);
    put({
      ...base,
      q: typed("q", p.q),
      t: p.t ?? null,
      sum: p.sum ?? null,
      tok: p.tok ?? 0,
      src: pages.length,
      model,
      effort,
      mod: null,
      modBy: null,
      modNote: null,
    });
    const runOf = (id: string, node: string, u: string, at: string, tok: number) =>
      put({
        kind: "run",
        id,
        th: p.id,
        s,
        node,
        u,
        model,
        effort,
        status: "complete",
        attempt: 1,
        step: 3,
        fail: null,
        tok,
        bill: "included",
        note: null,
        createdAt: at,
        startedAt: at,
        finishedAt: at,
      });
    runOf(rootRun, "r", p.u, p.createdAt, p.tok ?? 0);
    put({
      kind: "answer",
      node: "r",
      th: p.id,
      s,
      u: p.u,
      md: htmlToMarkdown(rootHtml, doc),
      pages,
      tok: p.tok ?? 0,
      run: rootRun,
      attempt: 1,
      mod: null,
    });
    const units = unitsOf(rootHtml, doc);

    // the mock's `tree`: an ask tree (`qtd`) or its follow-ups (`fu`)
    const fu = D.fu[p.id] ?? [];
    const list: FixtureNode[] =
      D.qtd[p.id]?.nodes ?? fu.map((_, i) => ({ id: `f${i}`, par: "r", fu: i }));
    const ids = new Map<string, string>();
    let nodes = 0;
    for (const n of list) {
      const f = n.fu !== undefined ? fu[n.fu] : undefined;
      const u = n.u ?? f?.u ?? p.u;
      const at = n.createdAt ?? f?.createdAt ?? p.createdAt;
      const q0 = n.q ?? f?.q ?? "";
      const html = n.html ?? f?.html ?? (f?.a ? `<p>${esc(f.a)}</p>` : "");
      const id = fixtureUlid(`node:${p.id}:${n.id}`, at);
      ids.set(n.id, id);
      const par = n.par === "r" ? "r" : (ids.get(n.par) ?? "r");
      const run = fixtureUlid(`run:${p.id}:${n.id}`, at);
      const summary = f?.a ?? clip(stripHtml(html), 200);
      const b = n.par === "r" ? bestPassage(units, `${q0} ${summary}`) : null;
      put({
        kind: "node",
        id,
        th: p.id,
        s,
        par,
        k: "ask",
        u,
        q: typed(n.fu !== undefined ? `f${n.fu}` : n.id, q0),
        look: null,
        quote: null,
        b,
        tpl: null,
        model,
        effort,
        run,
        promoted: null,
        mod: null,
        del: false,
        createdAt: at,
      });
      runOf(run, id, u, at, n.tok ?? 0);
      put({
        kind: "answer",
        node: id,
        th: p.id,
        s,
        u,
        md: htmlToMarkdown(html, doc),
        pages,
        tok: n.tok ?? 0,
        run,
        attempt: 1,
        mod: null,
      });
      nodes++;
      if (p.id === SEED_COMMENT.thread && nodes === 1) {
        put({
          kind: "comment",
          id: fixtureUlid(`comment:${p.id}:1`, SEED_COMMENT.createdAt),
          th: p.id,
          s,
          node: id,
          parent: null,
          u: SEED_COMMENT.u,
          t: SEED_COMMENT.t,
          edited: false,
          del: false,
          mod: null,
          createdAt: SEED_COMMENT.createdAt,
        });
      }
    }
    put({ kind: "counts", th: p.id, s, saves, r: nodes });
  }

  for (const [sp, stat] of posted) put({ kind: "stats", sp, posts: stat.n, updatedAt: stat.at });

  for (const b of D.banned) {
    const sp = spaceIds[b.sp];
    const meta = SPACE_META[b.sp];
    if (!sp || !meta) continue;
    put({ kind: "ban", id: `${sp}:${b.u}`, sp, u: b.u, createdAt: b.createdAt });
    put({
      kind: "modlog",
      id: fixtureUlid(`modlog:ban:${b.sp}:${b.u}`, b.createdAt),
      sp,
      act: "ban",
      item: null,
      by: meta.owner,
      author: b.u,
      note: "Posted the same link in every thread.",
      createdAt: b.createdAt,
    });
  }

  // @ines.v's notifications (`NOTIFS`)
  const reply = (th: string, path: string, at: string) =>
    `reply:${fixtureUlid(`reply:${th}:${path}`, at)}`;
  const firstNode = (th: string) =>
    out.find((r) => r.kind === "node" && r.th === th && r.par === "r");
  const NOTIFS: [
    string,
    string,
    string | null,
    string | null,
    string | null,
    string | null,
    boolean,
    string,
  ][] = [
    [
      "mention",
      "jun.park",
      "ml",
      SEED_POST.id,
      reply(SEED_POST.id, "1", "2026-11-16T08:12:00Z"),
      null,
      false,
      "2026-11-16T08:12:00Z",
    ],
    [
      "branch",
      "hal_b",
      "public",
      "01M7HWGZJGT7JTFFVSYPX055KV",
      `node:${fixtureUlid("node:01M7HWGZJGT7JTFFVSYPX055KV:h1", "2026-11-16T09:54:30Z")}`,
      null,
      false,
      "2026-11-16T09:54:30Z",
    ],
    [
      "removed",
      "mira_k",
      "replication",
      RM_ASK,
      `thread:${RM_ASK}`,
      RM_ASK_NOTE,
      false,
      "2026-11-16T07:00:00Z",
    ],
    [
      "reply",
      "lettie",
      "ml",
      SEED_POST.id,
      reply(SEED_POST.id, "0", "2026-11-15T21:05:00Z"),
      null,
      true,
      "2026-11-15T21:05:00Z",
    ],
    [
      "comment",
      "mira_k",
      "scifi",
      SEED_COMMENT.thread,
      `comment:${fixtureUlid(`comment:${SEED_COMMENT.thread}:1`, SEED_COMMENT.createdAt)}`,
      null,
      true,
      "2026-11-15T20:10:00Z",
    ],
    [
      "mention",
      "oduya",
      "markets",
      "01M7HGRPJ0E7RGZ45D4KENBQ6P",
      "thread:01M7HGRPJ0E7RGZ45D4KENBQ6P",
      null,
      true,
      "2026-11-15T16:30:00Z",
    ],
    ["invite_used", "priya.n", null, null, null, null, true, "2026-11-14T18:00:00Z"],
    ["branch", "jun.park", "scifi", SEED_COMMENT.thread, null, null, true, "2026-11-14T22:00:00Z"],
  ];
  NOTIFS.forEach(([type, actor, space, th, item, note, read, at], i) => {
    const first = th ? firstNode(th) : undefined;
    put({
      kind: "notif",
      id: fixtureUlid(`notif:${i}`, at),
      to: FIXTURE_MEMBER,
      type: type as "mention",
      sp: space ? (spaceIds[space] ?? null) : null,
      th,
      item: item ?? (first && "id" in first ? `node:${first.id}` : null),
      actor: type === "removed" ? null : actor,
      n: 1,
      note,
      read,
      createdAt: at,
    });
  });

  put({ kind: "prefs", u: FIXTURE_MEMBER, layout: "centred" });

  return {
    records: out.map((r) => ({ ...r, rev: 1 })),
    clock: isoToMs(F.clock),
    spaceIds,
  };
}
