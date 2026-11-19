// Checks the HTML mockup's mock backend (`docs/mockups/session-web-spaces-*.js`)
// against the Spaces schemas in `src/schemas/spaces.ts`: the fixtures, every
// GET row and paged query for three callers, one valid call of every
// procedure, the error bodies, and the events of an ask's run. It also checks
// that every row of the mock's API table has an entry in `spacesApi`, so a new
// procedure without a schema fails here.
//
// The mock is four classic scripts that define globals on `window`; they run
// here, imported in order, with `window` as `globalThis` and stubs for
// `localStorage` and `EventSource`. The backend patches the global `fetch` and
// `EventSource`. This package compiles without Node's or the DOM's types
// (`src/platform.d.ts`), so the test declares the few it uses below.
// Values are checked in their JSON form (a Set is `{ $set: [...] }`), and
// `exact` also fails when a value has a field its schema does not list, so a
// field the mock adds without a schema shows up.

import test from "ava";
import type { ExecutionContext } from "ava";
import type { z } from "zod";

import * as root from "../src/index.js";
import type { Spaces } from "../src/index.js";
import { researchTreeSummarySchema as realTreeSummarySchema } from "../src/schemas/research.js";
import {
  apiKeySchema,
  askTreeSchema,
  banSchema,
  closedSpaceStateSchema,
  deviceSchema,
  inboxNotificationSchema,
  inboxNotificationTypeSchema,
  joinRequestSchema,
  pageDocSchema,
  personSummarySchema,
  reportSchema,
  researchExchangeNodeSchema,
  researchNodeSchema,
  researchPostNodeSchema,
  researchTreeSummarySchema,
  sessionEventSchema,
  skillSchema,
  sourceReportSchema,
  sourceSchema,
  spaceCollectionSchemas,
  spaceErrorCodeSchema,
  spaceErrorSchema,
  spaceProcedureResponseSchema,
  spaceProcedures,
  spaceProfileSchema,
  spaceQueries,
  spaceReadRulesSchema,
  spaceRunSchema,
  spacesApi,
  spaceSchema,
  spaceSourceSchema,
  storedApiKeySchema,
  storedResearchTreeSummarySchema,
  storedSpaceCollectionSchemas,
  storedSpaceSchema,
  storedThreadInviteSchema,
  threadInviteSchema,
  threadMemberSchema,
  tokenUsageSchema,
  userSchema,
  userSettingsSchema,
} from "../src/schemas/spaces.js";
import type { notificationPayloadSchema, spacePageSchema } from "../src/schemas/spaces.js";
import type { InboxNotificationPage, NotificationPayload } from "../src/types/sharing.js";

// ---- the schemas' types against the real types they reuse ----

type Defined<T> = T extends readonly (infer Item)[]
  ? Defined<Item>[]
  : T extends object
    ? { [Key in keyof T]: Defined<Exclude<T[Key], undefined>> }
    : T;
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

const conformance: [
  Same<Defined<z.output<typeof notificationPayloadSchema>>, Defined<NotificationPayload>>,
  Same<
    z.output<ReturnType<typeof spacePageSchema<z.ZodString>>>["nextCursor"],
    InboxNotificationPage["nextCursor"]
  >,
] = [true, true];

test("the schemas that stand for real types match them", (t) => {
  t.true(conformance.every(Boolean));
});

// ---- exports: a namespace, and no name of the real app's taken ----

/** The types the package root exports as `Spaces.<name>` are this module's. */
const namespaced: [
  Same<Spaces.ResearchTreeSummary, z.output<typeof researchTreeSummarySchema>>,
  Same<Spaces.ResearchTreeDetail, Spaces.ResearchTreeSummary>,
  Same<Spaces.User, z.output<typeof userSchema>>,
] = [true, true, true];

test("the package root exports the Spaces schemas only under `spaces`", (t) => {
  t.true(namespaced.every(Boolean));
  t.is(root.spaces.researchTreeSummarySchema, researchTreeSummarySchema);
  t.is(root.spaces.researchTreeDetailSchema, researchTreeSummarySchema);
  t.is(root.researchTreeSummarySchema, realTreeSummarySchema);
  const values = new Set<unknown>(Object.values(root));
  const leaked = Object.entries(root.spaces)
    .filter(([, v]) => values.has(v))
    .map(([k]) => k);
  t.deepEqual(leaked, [], "values of the spaces module at the package root");
});

// ---- loading the mock ----

interface ApiRow {
  method: string;
  path: string;
  op: string;
  input: string | null;
  output: string | null;
  trpc: string | null;
  who: string;
  dev?: boolean;
}

/** One of the mock's hand-written schemas (section 3 of its API file). */
interface MockSchema {
  t: string;
  fields?: Record<string, MockSchema>;
  f?: () => MockSchema;
  vs?: unknown[];
}

interface MockApi {
  API: ApiRow[];
  SCHEMAS: Record<string, MockSchema>;
  NOTIFICATION_TYPES: string[];
  CODES: Record<string, unknown>;
  READ_RULES: Record<string, boolean>;
  PROCEDURES: Record<string, unknown>;
  COLLECTIONS: Record<string, { path: string; kind: string; computed?: unknown }>;
  enc: (value: unknown) => string;
  ulid: (ms: number, n: number) => string;
  createBackend: (options: Record<string, unknown>) => { restore: () => void };
}

/** The globals the test uses: the mock's, and the runtime's `fetch` and
 * `EventSource` (the mock's patches, once the backend starts). */
interface Globals {
  window: unknown;
  localStorage: {
    getItem(k: string): string | null;
    setItem(k: string, v: string): void;
    removeItem(k: string): void;
  };
  SessionMockApi: MockApi;
  SessionFixtures: { me: { u: string }; data: Record<string, unknown> };
  SessionScenarios: unknown;
  fetch(
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string },
  ): Promise<{ status: number; text(): Promise<string> }>;
  EventSource: new (url: string) => {
    addEventListener(type: "message", listener: (e: { data: string }) => void): void;
    close(): void;
  };
}

const g = globalThis as unknown as Globals;
const storage = new Map<string, string>();
g.window = globalThis;
g.localStorage = {
  getItem: (k) => storage.get(k) ?? null,
  setItem: (k, v) => void storage.set(k, v),
  removeItem: (k) => void storage.delete(k),
};
g.EventSource = function EventSource() {} as unknown as Globals["EventSource"];
/** The mock's scripts, by path from this file: a variable specifier, as they
 * have no types. */
const load = (path: string) => import(path) as Promise<unknown>;
for (const name of ["fixtures", "jobs", "mock-api", "scenarios"])
  await load(`../../../../docs/mockups/session-web-spaces-${name}.js`);

const M = g.SessionMockApi;
const me = g.SessionFixtures.me.u;
const backend = M.createBackend({
  fixtures: g.SessionFixtures,
  scenarios: g.SessionScenarios,
  latency: 0,
  dev: false,
});
test.after.always(() => backend.restore());

// ---- requests ----

type Json = unknown;
interface Answer {
  status: number;
  body: Json;
}
type Caller = "in" | "out";

async function request(
  method: string,
  url: string,
  body?: Json,
  caller: Caller = "in",
): Promise<Answer> {
  const headers: Record<string, string> = caller === "out" ? { "X-Session-Auth": "out" } : {};
  const init =
    body === undefined ? { method, headers } : { method, headers, body: JSON.stringify(body) };
  const res = await g.fetch(url, init);
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Json) : null };
}
const get = (path: string, caller?: Caller) => request("GET", path, undefined, caller);
const query = (name: string, input: Json, caller?: Caller) =>
  get(`/api/rpc/${name}?input=${encodeURIComponent(JSON.stringify(input))}`, caller);
const call = (name: string, input: Json, caller?: Caller) =>
  request("POST", `/api/rpc/${name}`, input, caller);
async function scenario(name: string, args?: Record<string, unknown>) {
  const res = await request("POST", "/api/dev/scenario", args ? { name, args } : { name });
  if (res.status !== 200) throw new Error(`scenario ${name}: ${JSON.stringify(res.body)}`);
  return res;
}
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(() => resolve(), ms));

/** The value parses, and parsing keeps every field: a field the schema does
 * not list would be stripped, and the comparison shows it. */
function exact(t: ExecutionContext, schema: z.ZodType, value: Json, label: string) {
  const r = schema.safeParse(value);
  if (!r.success) {
    t.fail(`${label}: ${JSON.stringify(r.error.issues.slice(0, 4))}`);
    return;
  }
  t.deepEqual(r.data, value, `${label}: a field the schema does not list`);
}

// GET rows in the mock's API table
const apiKey = (r: ApiRow) => `${r.method} ${r.path}`;
const schemaOf = (r: ApiRow) => {
  const s = spacesApi[apiKey(r)];
  if (!s) throw new Error(`no spacesApi entry for ${apiKey(r)}`);
  return s;
};

// ---- coverage ----

test("every row of the mock's API table has schemas for its input and output", (t) => {
  for (const r of M.API) {
    const s = spacesApi[apiKey(r)];
    if (!s) {
      t.fail(`${apiKey(r)} has no entry in spacesApi`);
      continue;
    }
    t.is(s.input !== null, r.input !== null, `${apiKey(r)}: input`);
    t.is(s.output !== null, r.output !== null, `${apiKey(r)}: output`);
  }
  const rows = new Set(M.API.map(apiKey));
  for (const k of Object.keys(spacesApi))
    t.true(rows.has(k), `spacesApi has ${k}, which the mock does not`);
  t.deepEqual(Object.keys(spaceProcedures).sort(), Object.keys(M.PROCEDURES).sort());
  const queries = M.API.filter((r) => r.op === "query").map((r) => r.trpc);
  t.deepEqual(Object.keys(spaceQueries).sort(), queries.sort());
  t.deepEqual(Object.keys(spaceCollectionSchemas).sort(), Object.keys(M.COLLECTIONS).sort());
});

// ---- the mock's own schemas agree with these ----

/** Each of the mock's record schemas (`S.*`, by the mock's own names) and
 * the schemas here that describe it: the response shape and, where it
 * differs, the stored one. */
const MOCK_SCHEMAS: Record<string, z.ZodType[]> = {
  Space: [spaceSchema, storedSpaceSchema],
  Thread: [researchTreeSummarySchema, storedResearchTreeSummarySchema],
  Reply: [researchPostNodeSchema],
  FollowUp: [researchExchangeNodeSchema],
  AskNode: [researchNodeSchema],
  Run: [spaceRunSchema],
  AskTree: [askTreeSchema],
  Source: [sourceSchema],
  ApiKey: [apiKeySchema, storedApiKeySchema],
  Notification: [inboxNotificationSchema],
  JoinRequest: [joinRequestSchema],
  Member: [threadMemberSchema],
  Ban: [banSchema],
  InviteLink: [threadInviteSchema, storedThreadInviteSchema],
  Report: [reportSchema],
  SpaceSource: [spaceSourceSchema],
  SourceReport: [sourceReportSchema],
  Skill: [skillSchema],
  PageDoc: [pageDocSchema],
  Profile: [spaceProfileSchema],
  PersonSummary: [personSummarySchema],
  Me: [userSchema],
  Usage: [tokenUsageSchema],
  Settings: [userSettingsSchema],
  Device: [deviceSchema],
};

test("the mock's hand-written schemas list the same fields", (t) => {
  const fieldsOf = (s: MockSchema): string[] => {
    while (s.t === "lazy" && s.f) s = s.f();
    return Object.keys(s.fields ?? {}).map((k) => k.replace(/\?$/, ""));
  };
  const keysOf = (schemas: z.ZodType[]) =>
    new Set(schemas.flatMap((s) => Object.keys((s as z.ZodObject).shape)));
  const differences: string[] = [];
  for (const [name, s] of Object.entries(M.SCHEMAS)) {
    if (s.t === "enum") continue;
    const ours = MOCK_SCHEMAS[name];
    if (!ours) {
      differences.push(`S.${name} has no schema here`);
      continue;
    }
    const mock = new Set(fieldsOf(s)),
      here = keysOf(ours);
    for (const k of here) if (!mock.has(k)) differences.push(`S.${name} does not list ${k}`);
    for (const k of mock)
      if (!here.has(k)) differences.push(`S.${name} lists ${k}, which the schema here does not`);
  }
  t.deepEqual(differences, []);
  t.deepEqual(M.SCHEMAS.ClosedSpaceState?.vs, closedSpaceStateSchema.options);
  t.deepEqual(M.NOTIFICATION_TYPES, inboxNotificationTypeSchema.options);
  t.deepEqual(Object.keys(M.CODES), spaceErrorCodeSchema.options);
  t.deepEqual(Object.keys(M.READ_RULES), Object.keys(spaceReadRulesSchema.shape));
});

// ---- fixtures ----

test.serial("every fixture record has the stored shape of its collection", (t) => {
  const data = JSON.parse(M.enc(g.SessionFixtures.data)) as Record<string, Json>;
  for (const [k, c] of Object.entries(M.COLLECTIONS)) {
    if (c.computed) continue;
    const schema = storedSpaceCollectionSchemas[k as keyof typeof storedSpaceCollectionSchemas];
    t.true(k in data, `the fixtures have ${k}`);
    exact(t, schema, data[k], `fixtures.${k}`);
  }
  for (const k of Object.keys(data)) t.true(k in M.COLLECTIONS, `fixtures.${k} is a collection`);
});

// ---- GET rows and paged queries, per caller ----

/** A first page's input for each query. */
const QUERY_INPUT: Record<keyof typeof spaceQueries, Json[]> = {
  "threads.feed": [{}, { scope: "all", kind: "ask", limit: 5 }, { scope: "public" }],
  "threads.list": [
    { space: "public" },
    { space: "replication" },
    { space: "sablefield", topic: "other" },
  ],
  "notifications.list": [{}],
  "notifications.unreadCount": [{}],
  "users.listThreads": [{ handle: "hal_b" }, { handle: me }],
  "users.listFollowUps": [{ handle: "hal_b" }, { handle: me }],
  "saved.list": [{}],
  "search.threads": [{ q: "replication" }],
  "members.list": [{ space: "replication" }, { space: "public" }],
  "joinRequests.list": [{ space: "replication" }],
  "reports.list": [{ space: "sablefield" }],
  "spaceSources.list": [{ space: "ml" }, { space: "public" }],
  "usage.listAsks": [{}],
};

/** The three callers: a member of the closed #replication-club, a person who
 * is not, and nobody (signed out). */
const CALLERS: [string, () => Promise<unknown>, Caller][] = [
  ["a member", () => scenario("replication: moderator"), "in"],
  ["a non-member", () => scenario("seed"), "in"],
  ["signed out", () => scenario("seed"), "out"],
];

for (const [who, setUp, caller] of CALLERS) {
  test.serial(`GET rows and first pages, ${who}`, async (t) => {
    await setUp();
    const threads = (await get("/api/threads")).body as { id: string }[];
    const answers = (await get("/api/answers")).body as Record<string, string>;
    const ids: Record<string, string> = {
      "/api/threads/:id": threads[0]?.id ?? "",
      "/api/answers/:id": Object.keys(answers)[0] ?? "",
    };
    for (const r of M.API) {
      if (r.method !== "GET" || r.op === "query" || r.op === "events") continue;
      const path = r.path.includes(":id") ? r.path.replace(":id", ids[r.path] ?? "") : r.path;
      const res = await get(path, caller);
      if (res.status === 200) exact(t, schemaOf(r).output!, res.body, `${who}: GET ${path}`);
      else {
        t.is(res.status, 401, `${who}: GET ${path}`);
        t.not(r.who, "guest", `${who}: GET ${path} is for guests`);
        exact(t, spaceErrorSchema, res.body, `${who}: GET ${path} error`);
      }
    }
    for (const [name, inputs] of Object.entries(QUERY_INPUT)) {
      const q = spaceQueries[name as keyof typeof spaceQueries];
      for (const input of inputs) {
        exact(t, q.input, input, `${name} input`);
        const res = await query(name, input, caller);
        if (res.status === 200)
          exact(t, q.output, res.body, `${who}: ${name} ${JSON.stringify(input)}`);
        else {
          t.is(res.status, 401, `${who}: ${name}`);
          exact(t, spaceErrorSchema, res.body, `${who}: ${name} error`);
        }
      }
    }
  });
}

test.serial("a paged query's next pages", async (t) => {
  await scenario("seed");
  let cursor: string | null = null;
  let pages = 0;
  do {
    const res = await query("threads.list", { space: "sablefield", limit: 3, cursor });
    exact(t, spaceQueries["threads.list"].output, res.body, `page ${pages}`);
    cursor = (res.body as { nextCursor: string | null }).nextCursor;
    pages += 1;
  } while (cursor && pages < 20);
  t.true(pages > 1);
  t.is(cursor, null);
});

// ---- procedures: one valid call each ----

interface Thread {
  id: string;
  s: string;
  u: string;
  k: string;
  q: string;
  running?: boolean;
  rev?: number;
}

const threadsNow = async () => (await get("/api/threads")).body as Thread[];
const find = <T>(list: T[], ok: (x: T) => boolean, what: string): T => {
  const x = list.find(ok);
  if (!x) throw new Error(`no ${what}`);
  return x;
};
const askIn = async (space: string) =>
  find(await threadsNow(), (p) => p.s === space && p.k === "ask" && !p.running, `ask in ${space}`)
    .id;
const postIn = async (space: string) =>
  find(await threadsNow(), (p) => p.s === space && p.k === "post", `post in ${space}`).id;
const ownAsk = async (space: string) =>
  find(
    await threadsNow(),
    (p) => p.s === space && p.u === me && p.k === "ask",
    `your ask in ${space}`,
  ).id;

interface ProcCall {
  /** The scenario the call starts from (default: the seed). */
  scenario?: [string, Record<string, unknown>?];
  /** Calls before it, also checked. */
  before?: [string, () => unknown][];
  /** The input, or a function that finds it in the data. */
  input: object | (() => unknown);
}
const inputOf = async (c: ProcCall): Promise<unknown> =>
  typeof c.input === "function" ? await (c.input as () => unknown)() : c.input;

const OWN_POST_TEXT =
  "Notes from Thursday’s reading group are on the wiki page. Next week: chapters 4 to 6.";
/** The id of the reply at a place in a thread's replies ("1", "0.0"):
 * replies are named by id (phase 1b). */
const replyAt = async (th: string, path: string) => {
  const all = (await get("/api/replies")).body as Record<
    string,
    { id: string; kids?: { id: string }[] }[]
  >;
  const [i, j] = path.split(".").map(Number);
  const top = (all[th] ?? [])[i ?? 0];
  const r = j === undefined ? top : top?.kids?.[j];
  if (!r) throw new Error(`no reply ${path} in ${th}`);
  return r.id;
};
const ownPost = async () =>
  find(
    await threadsNow(),
    (p) => p.u === me && p.k === "post" && p.q === OWN_POST_TEXT,
    "your post",
  ).id;
const runningAsk = async () =>
  find(await threadsNow(), (p) => p.u === me && p.k === "ask" && !!p.running, "your running ask")
    .id;
async function ownNode() {
  const trees = (await get("/api/ask-trees")).body as Record<
    string,
    { nodes: { id: string; u?: string; fu?: number }[] }
  >;
  for (const [thread, tree] of Object.entries(trees)) {
    const n = tree.nodes.find((x) => x.u === me && x.fu === undefined);
    if (n) return { thread, node: n.id };
  }
  throw new Error("no follow-up node of yours");
}
async function openRequest(space: string) {
  const res = await query("joinRequests.list", { space, state: "open" });
  return find(
    (res.body as { items: { u: string }[] }).items,
    () => true,
    `open request in ${space}`,
  ).u;
}
async function joinAnswers(space: string) {
  const spaces = (await get("/api/spaces")).body as { id: string; qs?: unknown[] }[];
  return (find(spaces, (s) => s.id === space, space).qs ?? []).map(
    () => "Re-running published results.",
  );
}

/** A record's version as the page holds it (absent: 1). */
const revOf = (x: { rev?: number } | undefined) => x?.rev ?? 1;
const threadRev = async (id: string) => revOf((await threadsNow()).find((p) => p.id === id));
/** A space's page ids (the third item of each entry). */
async function pageIds(space: string) {
  const spaces = (await get("/api/spaces")).body as { id: string; pages?: string[][] }[];
  return (find(spaces, (s) => s.id === space, space).pages ?? []).map((p) => p[2] ?? "");
}
async function skillIds(space: string) {
  const skills = (await get("/api/space-skills")).body as Record<string, { id: string }[]>;
  return (skills[space] ?? []).map((x) => x.id);
}
/** A device run of yours on this Mac (d1), queued: its id. */
async function deviceRun() {
  const r = await call("threads.create", {
    space: "public",
    kind: "ask",
    q: "Which tide gauges have the longest records?",
    executor: { kind: "device", cli: "claude", device: "d1" },
  });
  return (r.body as { result: { run: string } }).result.run;
}

const PROC_CALLS: Record<keyof typeof spaceProcedures, ProcCall> = {
  "likes.set": { input: async () => ({ thread: await askIn("public"), on: true }) },
  "likes.setReply": {
    input: async () => ({ reply: await replyAt(await postIn("public"), "0"), on: true }),
  },
  "saved.set": { input: async () => ({ kind: "thread", id: await askIn("public"), on: true }) },
  "mutes.set": { input: { handle: "hal_b", on: true } },
  "blocks.set": { input: { handle: "hal_b", on: true } },
  "sources.markRead": { input: { id: "m1" } },
  "threads.create": {
    input: { space: "public", kind: "ask", q: "Which tide gauges have the longest records?" },
  },
  "threads.update": {
    input: async () => {
      const id = await ownAsk("public");
      return { id, q: "An edited question?", base: { rev: await threadRev(id) } };
    },
  },
  "threads.delete": { input: async () => ({ id: await ownAsk("public") }) },
  "threads.move": { input: async () => ({ id: await askIn("sablefield"), topic: null }) },
  "followups.ask": {
    input: async () => ({ thread: await askIn("public"), q: "What changed since then?" }),
  },
  "research.createPostFollowUp": {
    input: async () => ({ thread: await postIn("public"), t: "Thanks for the notes." }),
  },
  "research.forkNode": {
    input: async () => ({
      thread: await askIn("public"),
      parent: "r",
      q: "Which source is newest?",
    }),
  },
  "replies.update": {
    scenario: ["threads: your post with replies"],
    input: async () => {
      const thread = await ownPost();
      return {
        thread,
        reply: await replyAt(thread, "1"),
        t: "I added the questions for chapters 4 and 5.",
        base: { rev: 1 },
      };
    },
  },
  "replies.delete": {
    scenario: ["threads: your post with replies"],
    input: async () => {
      const thread = await ownPost();
      return { thread, reply: await replyAt(thread, "0.0") };
    },
  },
  "followups.update": {
    input: async () => ({ ...(await ownNode()), q: "An edited follow-up?", base: { rev: 1 } }),
  },
  "followups.delete": { input: ownNode },
  "research.cancelNode": {
    scenario: ["asks: your ask", { space: "public", end: "running" }],
    input: async () => ({ thread: await runningAsk(), node: "r" }),
  },
  "research.retryNode": {
    scenario: ["asks: your ask", { space: "public", end: "stopped" }],
    input: async () => ({ thread: await ownAsk("public"), node: "r", pay: "session" }),
  },
  "usage.setDefaultKey": { input: { id: "k1" } },
  "usage.markMovedSeen": { input: {} },
  "spaces.join": { input: { space: "bio" } },
  // an invite to a closed space carries a link's code (the notification alone admits nobody)
  "spaces.leave": { input: { space: "public" } },
  "onboarding.finish": { input: { spaces: ["public", "bio"] } },
  "invites.decline": { input: { notification: "ninv" } },
  "invites.request": { input: { space: "ward7" } },
  "joinRequests.create": {
    input: async () => ({
      space: "replication",
      answers: await joinAnswers("replication"),
      rulesAccepted: true,
    }),
  },
  "joinRequests.withdraw": { scenario: ["replication: pending"], input: { space: "replication" } },
  "joinRequests.decide": {
    scenario: ["replication: moderator"],
    input: async () => ({
      space: "replication",
      users: [await openRequest("replication")],
      decision: "approve",
      base: { [await openRequest("replication")]: 1 },
    }),
  },
  "members.setRole": { input: { space: "ml", user: "hal_b", role: "mod", base: { rev: 1 } } },
  // closed spaces only: in an open one, moderators ban
  "members.remove": {
    scenario: ["replication: moderator"],
    input: { space: "replication", user: "oduya", base: { adm: "" } },
  },
  "members.ban": { input: { space: "ml", user: "hal_b" } },
  "members.unban": {
    before: [["members.ban", () => ({ space: "ml", user: "hal_b" })]],
    input: { space: "ml", user: "hal_b" },
  },
  "reports.create": {
    input: async () => ({ item: `a:${await askIn("public")}`, why: "old", note: "Out of date." }),
  },
  "reports.resolve": { input: { report: "rp1", outcome: "dismissed" } },
  "moderation.decide": {
    input: async () => ({ item: `a:${await askIn("sablefield")}`, decision: "hidden" }),
  },
  "devices.revoke": { input: { id: "d3" } },
  "devices.authorize": { input: { name: "Mac Studio" } },
  "devices.approve": {
    input: async () => {
      const r = await call("devices.authorize", { name: "Mac Studio" });
      const s = (r.body as { result: { request: string; code: string } }).result;
      return { request: s.request, code: s.code };
    },
  },
  "runs.claim": { input: async () => ({ run: await deviceRun(), device: "d1" }) },
  "runs.heartbeat": {
    input: async () => {
      const run = await deviceRun();
      await call("runs.claim", { run, device: "d1" });
      return { run, device: "d1", attempt: 1 };
    },
  },
  "runs.turn": {
    input: async () => {
      const run = await deviceRun();
      await call("runs.claim", { run, device: "d1" });
      return { run, device: "d1", attempt: 1, turn: { tool: "read", input: "notes" } };
    },
  },
  "runs.finish": {
    input: async () => {
      const run = await deviceRun();
      await call("runs.claim", { run, device: "d1" });
      return { run, device: "d1", attempt: 1, answer: "<p>The Brest gauge, since 1711.</p>" };
    },
  },
  "notifications.markRead": { input: { id: "n1" } },
  "notifications.markAllRead": { input: {} },
  "notifications.markSeen": { input: { kind: "reports" } },
  "invites.create": { input: { space: "scifi", days: 7 } },
  "invites.revoke": { input: { id: "l4" } },
  "invites.restore": { before: [["invites.revoke", () => ({ id: "l4" })]], input: { id: "l4" } },
  "spaces.create": {
    input: {
      name: "tide-gauges",
      desc: "Readings from coastal tide gauges.",
      vis: "listed",
      policy: "request",
      qs: [{ q: "What will you work on?", req: true }],
      invite: "mods",
    },
  },
  "spaces.update": {
    input: {
      id: "ml",
      set: { desc: "Paper summaries and replications.", rules: ["Link the arXiv ID."] },
      base: { rulesAt: null },
    },
  },
  "spaces.verifyDomain": { input: { id: "ml", domain: "mlpapers.example" } },
  "spaces.archive": { input: { id: "math", archived: true } },
  "spaces.delete": { input: { id: "math" } },
  "skills.create": {
    input: {
      space: "scifi",
      name: "comparing-editions",
      prompt: "Compare two editions.\n\nList the differences.",
    },
  },
  "skills.update": {
    input: async () => ({
      space: "scifi",
      id: (await skillIds("scifi"))[0],
      name: "renamed-skill",
      prompt: "A new prompt.",
      base: { rev: 0 },
    }),
  },
  "skills.remove": { input: async () => ({ space: "scifi", id: (await skillIds("scifi"))[0] }) },
  "skills.reorder": {
    input: async () => ({
      space: "scifi",
      order: (await skillIds("scifi")).reverse(),
      base: { rev: 0 },
    }),
  },
  "pages.update": {
    input: {
      space: "scifi",
      page: null,
      title: "Reading order",
      text: ["Start with the short stories."],
    },
  },
  "pages.restore": {
    before: [
      [
        "pages.update",
        () => ({
          space: "scifi",
          page: "pg-scifi-2",
          title: "Canon starter list",
          text: ["A new text."],
        }),
      ],
    ],
    input: { space: "scifi", page: "pg-scifi-2", rev: 0, note: "Restored the version from Nov 16" },
  },
  "pages.remove": { input: async () => ({ space: "scifi", page: (await pageIds("scifi"))[0] }) },
  "pages.move": {
    input: async () => {
      const [a, b] = await pageIds("scifi");
      return { space: "scifi", page: a, other: b };
    },
  },
  "apiKeys.create": {
    input: { raw: "sk-ant-api03-test-key-0001", label: "Test key", check: true, cap: 1000 },
  },
  "apiKeys.replace": { input: { id: "k1", raw: "sk-ant-api03-test-key-0002" } },
  "apiKeys.check": { input: { id: "k1" } },
  "apiKeys.rename": { input: { id: "k1", label: "Main key" } },
  "apiKeys.setCap": { input: { id: "k1", cap: 500000 } },
  "apiKeys.revoke": { input: { id: "k2" } },
  "profile.update": { input: { name: "Ines Vidal", bio: "Reads papers about benchmarks." } },
  "settings.update": {
    input: { emailOn: false, types: { pages: true }, spaces: { public: "all" }, export: true },
  },
  "spaceSources.add": {
    input: { space: "public", url: "https://example.org/tide-gauges", note: "Station list." },
  },
  "spaceSources.review": { input: { space: "ml", source: "m9", decision: "remove" } },
  "spaceSources.setPolicy": { input: { space: "ml", policy: "review" } },
  "sourceReports.create": { input: { space: "public", source: "m2", why: "broken" } },
};

/** A procedure call that must succeed: its input and answer are checked. */
async function valid(t: ExecutionContext, name: string, input: Json) {
  const p = spaceProcedures[name as keyof typeof spaceProcedures];
  exact(t, p.input, input, `${name} input`);
  const res = await call(name, input);
  t.is(res.status, 200, `${name}: ${JSON.stringify(res.body)}`);
  exact(t, spaceProcedureResponseSchema(p.result), res.body, `${name} answer`);
  return res.body as { result: Json; changes: Record<string, unknown> };
}

for (const [name, c] of Object.entries(PROC_CALLS)) {
  test.serial(`procedure ${name}`, async (t) => {
    const [sc, args] = c.scenario ?? ["seed"];
    exact(
      t,
      spacesApi["POST /api/dev/scenario"]!.output!,
      (await scenario(sc, args)).body,
      `scenario ${sc}`,
    );
    for (const [before, input] of c.before ?? []) await valid(t, before, await input());
    const answer = await valid(t, name, await inputOf(c));
    t.true(
      Object.keys(answer.changes).length > 0 ||
        name === "spaces.verifyDomain" ||
        name === "devices.authorize",
      `${name} changed nothing`,
    );
  });
}

// ---- error bodies ----

test.serial("a BAD_REQUEST has issues", async (t) => {
  await scenario("seed");
  const res = await call("likes.set", { thread: 5 });
  t.is(res.status, 400);
  exact(t, spaceErrorSchema, res.body, "BAD_REQUEST");
  t.true(((res.body as { issues?: string[] }).issues ?? []).length > 0);
  const page = await query("threads.feed", { cursor: "not a cursor" });
  t.is(page.status, 400);
  exact(t, spaceErrorSchema, page.body, "BAD_REQUEST (cursor)");
});

test.serial("a FORBIDDEN and an UNAUTHORIZED", async (t) => {
  await scenario("seed");
  const res = await call("spaces.archive", { id: "ml", archived: true });
  t.is(res.status, 403);
  exact(t, spaceErrorSchema, res.body, "FORBIDDEN");
  const out = await call("likes.set", { thread: (await threadsNow())[0]?.id, on: true }, "out");
  t.is(out.status, 401);
  exact(t, spaceErrorSchema, out.body, "UNAUTHORIZED");
});

test.serial("a CONFLICT has the current version and the changes", async (t) => {
  for (const [sc, name, input] of [
    [
      "ml: mira_k saved a skill",
      "skills.update",
      { space: "ml", id: "sk-ml-1", name: "summarizing-papers", prompt: "Mine.", base: { rev: 0 } },
    ],
    [
      "ml: mira_k changed the rules",
      "spaces.update",
      { id: "ml", set: { rules: ["Mine."] }, base: { rulesAt: null } },
    ],
    [
      "scifi: tomasz saved a page",
      "pages.update",
      {
        space: "scifi",
        page: "pg-scifi-2",
        title: "Canon starter list",
        text: ["Mine."],
        base: { rev: 0 },
      },
    ],
  ] as const) {
    await scenario(sc);
    const res = await call(name, input);
    t.is(res.status, 409, `${name}: ${JSON.stringify(res.body)}`);
    exact(t, spaceErrorSchema, res.body, `CONFLICT ${name}`);
    const body = res.body as { current?: unknown; changes?: Record<string, unknown> };
    t.truthy(body.current, `${name}: current`);
    t.true(Object.keys(body.changes ?? {}).length > 0, `${name}: changes`);
  }
});

test.serial("a new skill has rev 0, and each save adds one", async (t) => {
  await scenario("seed");
  type Skill = z.output<typeof skillSchema>;
  const skills = async () =>
    ((await get("/api/space-skills")).body as Record<string, Skill[]>).scifi ?? [];
  await valid(t, "skills.create", { space: "scifi", name: "dating-editions", prompt: "Dates it." });
  const index = (await skills()).findIndex((x) => x.name === "dating-editions");
  const id = (await skills())[index]?.id ?? "";
  t.like((await skills())[index], { name: "dating-editions", prompt: "Dates it.", rev: 0 });
  for (const rev of [0, 1]) {
    const prompt = `Dates it, version ${rev + 1}.`;
    await valid(t, "skills.update", {
      space: "scifi",
      id,
      name: "dating-editions",
      prompt,
      base: { rev },
    });
    t.deepEqual((await skills())[index], { id, name: "dating-editions", prompt, rev: rev + 1 });
  }
});

test.serial("a STALE has the current version and the changes", async (t) => {
  await scenario("seed");
  const id = find(await threadsNow(), (p) => p.u === me && p.k === "ask", "your ask").id;
  await valid(t, "threads.update", { id, q: "Edited once?", base: { rev: 1 } });
  const res = await call("threads.update", { id, q: "Edited twice?", base: { rev: 1 } });
  t.is(res.status, 409);
  exact(t, spaceErrorSchema, res.body, "STALE");
  t.like(res.body, { code: "STALE", current: { rev: 2, q: "Edited once?" } });
});

test.serial("the write envelope: a recorded answer is replayed; the sync codes", async (t) => {
  await scenario("seed");
  const reg = await request("POST", "/api/sync/register", {});
  exact(t, spacesApi["POST /api/sync/register"]!.output!, reg.body, "register");
  const { clientId, serverTime } = reg.body as { clientId: string; serverTime: number };
  const thread = await askIn("public");
  const env = (seq: number, mutationId: string, o: Record<string, unknown> = {}) => ({
    clientId,
    seq,
    mutationId,
    clientTime: serverTime,
    queuedAt: serverTime - 1000,
    replaces: [],
    name: "likes.set",
    input: { thread, on: true },
    ...o,
  });
  const write = async (e: object) => {
    exact(t, spacesApi["POST /api/sync/write"]!.input!, e, "envelope");
    const r = await request("POST", "/api/sync/write", e);
    exact(t, spacesApi["POST /api/sync/write"]!.output!, r.body, "answer");
    return r.body as { code?: string; seq?: number; replayed?: boolean };
  };
  const m1 = M.ulid(serverTime - 1000, 1);
  t.like(await write(env(1, m1)), { seq: 1 });
  t.like(await write(env(1, m1)), { seq: 1, replayed: true });
  t.like(await write(env(3, M.ulid(serverTime, 2))), { code: "OUT_OF_ORDER" });
  t.like(await write(env(2, M.ulid(serverTime - 5 * 864e5, 3))), { code: "EXPIRED", seq: 2 });
  t.like(await write(env(3, M.ulid(serverTime, 4), { clientId: "nope" })), {
    code: "WRONG_CLIENT",
  });
});

// ---- events ----

interface StreamEvent {
  type: string;
  payload: Record<string, unknown>;
}

/** An event stream: EventSource on the mock's subscription. */
function subscribe() {
  const events: StreamEvent[] = [];
  const source = new g.EventSource("/api/rpc/events.subscribe");
  source.addEventListener("message", (e) => events.push(JSON.parse(e.data) as StreamEvent));
  return { events, close: () => source.close() };
}
async function until(t: ExecutionContext, ok: () => boolean, what: string) {
  for (let i = 0; i < 200 && !ok(); i++) await sleep(10);
  t.true(ok(), `waited for ${what}`);
}

test.serial("the events of an ask's run, from start to finish", async (t) => {
  await scenario("seed");
  const stream = subscribe();
  try {
    await until(t, () => stream.events.length > 0, "connection.ready");
    t.is(stream.events[0]?.type, "connection.ready");
    const answer = await valid(t, "threads.create", {
      space: "public",
      kind: "ask",
      q: "Which tide gauges have the longest records?",
    });
    const id = (answer.result as { id: string }).id;
    const done = () => stream.events.some((e) => e.type === "notification.requested");
    await until(t, done, "the run to finish");
    const nodeOf = (e: StreamEvent) => {
      const p = e.payload as { nodeId?: string; node?: { id?: string } };
      return p.nodeId ?? p.node?.id ?? "";
    };
    const run = stream.events.filter((e) => nodeOf(e).startsWith(id));
    t.deepEqual(
      run.map((e) => e.type),
      [
        "research.run.started",
        "research.node.updated",
        "research.turn.committed",
        "research.turn.committed",
        "research.turn.committed",
        "research.run.finished",
        "research.node.updated",
      ],
    );
    for (const e of stream.events) exact(t, sessionEventSchema, e, `event ${e.type}`);
  } finally {
    stream.close();
  }
});

test.serial("the events of a key check and a domain check", async (t) => {
  await scenario("seed");
  await request("PUT", "/api/dev/config", { checkMs: 5 });
  const stream = subscribe();
  try {
    await valid(t, "apiKeys.create", {
      raw: "sk-ant-api03-revoked-0003",
      label: "Old key",
      check: true,
    });
    await valid(t, "spaces.verifyDomain", { id: "ml", domain: "mlpapers.example" });
    await until(
      t,
      () =>
        ["apiKeys.updated", "workspace.updated"].every((ty) =>
          stream.events.some((e) => e.type === ty),
        ),
      "both checks",
    );
    for (const e of stream.events) exact(t, sessionEventSchema, e, `event ${e.type}`);
  } finally {
    stream.close();
    await request("PUT", "/api/dev/config", { checkMs: 1400 });
  }
});

test.serial("the dev config", async (t) => {
  const res = await get("/api/dev/config");
  exact(t, spacesApi["GET /api/dev/config"]!.output!, res.body, "dev config");
  const input = { pageSize: 5, readRules: { closedThreads: false } };
  exact(t, spacesApi["PUT /api/dev/config"]!.input!, input, "dev config input");
  const put = await request("PUT", "/api/dev/config", input);
  exact(t, spacesApi["PUT /api/dev/config"]!.output!, put.body, "dev config after PUT");
  await request("PUT", "/api/dev/config", { pageSize: null, readRules: { closedThreads: true } });
});
