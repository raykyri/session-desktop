// Phase 3: the client on a platform that keeps its outbox (the Desktop
// app): the outbox's items with the mockup's copy (`spaces/outbox.ts`), a
// write a screen waits on only while it is sent (`useWrite`, `queued`), the
// writes an earlier run left sent at start, and the session's watch of its
// connection.

import * as pkg from "@session/mutators";
import type {
  Change,
  CursorMap,
  Envelope,
  LogId,
  OutboxEntry,
  PushResult,
  StoredRecord,
  Transport,
} from "@session/sync/client";
import { MemoryStorage, NO_RESPONSE, Offline } from "@session/sync/client";
import { act, cleanup, render, screen } from "@testing-library/react";
import test from "ava";

import { meResource } from "../src/api/account.js";
import { setFetch } from "../src/api/http.js";
import { setPlatform, webPlatform } from "../src/platform.js";
import {
  MODERATION,
  describe,
  isModeration,
  listHead,
  statusOf,
  type ObItem,
} from "../src/spaces/outbox.js";
import {
  Toasts,
  WRITE_ERROR,
  isAwaited,
  pruneToasts,
  savedToast,
  stickyToast,
  toast,
  useWrite,
  type Outcome,
} from "../src/spaces/writes.js";
import { SpacesProvider } from "../src/sync/react.js";
import { Reader } from "../src/sync/reader.js";
import { SpacesSession } from "../src/sync/session.js";

import { createFetchStub } from "./fetchStub.js";
import { testUser, waitUntil } from "./helpers.js";

test.afterEach.always(() => {
  cleanup();
  setPlatform(null);
});

const NOW = Date.parse("2026-11-16T10:00:00Z");
const DAY = 86_400_000;
const SP = "01M2JF0CG0R6DSGAXNG6C1ZTM5";
const TH = "01M769ZZR0AGZ2PQESX65WRGQS";
const RP = "01M7E164R000000000YCPQT001";
const PG = "01M2JF0CG0PAGE00000000000A";

const rec = (r: Record<string, unknown>) => r as unknown as StoredRecord;
const RECORDS: Record<string, StoredRecord> = {
  [`space:${SP}`]: rec({ kind: "space", id: SP, name: "sablefield", title: "Sablefield" }),
  [`thread:${TH}`]: rec({ kind: "thread", id: TH, s: SP, u: "devin_o", k: "post", q: "4.2" }),
  [`reply:${RP}`]: rec({ kind: "reply", id: RP, th: TH, s: SP, u: "bram", t: "Get 50% off" }),
  [`page:${PG}`]: rec({ kind: "page", id: PG, sp: SP, slug: "canon", t: "Canon" }),
};
const reader = new Reader(
  {
    get: (k) => RECORDS[k],
    keys: () => new Set(Object.keys(RECORDS)),
    pendingAt: () => false,
  },
  "ines.v",
);
const label = (sp: string) => (sp === SP ? "Sablefield" : null);

/** An outbox entry (the fields `describe` reads). */
const entry = (name: string, input: unknown, o: Partial<OutboxEntry> = {}): OutboxEntry => ({
  local: "L1",
  mutationId: "01M7E164R0AAAAAAAAAAAAAAAA",
  name,
  input,
  queuedAt: NOW - 20 * 60_000,
  replaces: [],
  uncertain: false,
  sent: false,
  wire: false,
  tries: 0,
  next: 0,
  state: "queued",
  minted: [],
  ...o,
});

const here = { here: "this Mac", offline: false, now: NOW };

test("each write is described by what it is and where, with the person's text", (t) => {
  const d = (name: string, input: unknown) => describe(entry(name, input), reader, label, NOW);
  t.like(d("research.createPostFollowUp", { thread: TH, t: "Does it?" }), {
    kind: "reply",
    title: "Reply in Sablefield",
    text: "Does it?",
    noun: "reply",
    space: SP,
    thread: TH,
  });
  t.like(d("likes.set", { thread: TH, on: true }), {
    kind: "like",
    title: "Like on devin_o’s post in Sablefield",
    text: "",
  });
  t.like(d("threads.create", { id: "x", space: SP, kind: "post", q: "Notes" }), {
    kind: "post",
    title: "Post in Sablefield",
    text: "Notes",
  });
  t.like(d("research.forkNode", { thread: TH, parent: "r", q: "Which?" }), {
    kind: "fu",
    title: "Follow-up in Sablefield",
    text: "Which?",
  });
  t.like(
    d("pages.update", {
      space: SP,
      page: PG,
      title: "Canon",
      text: ["One", "Two"],
      base: { rev: 0 },
    }),
    { kind: "page", title: "Edit of Canon in Sablefield", text: "One\n\nTwo", page: PG },
  );
  t.like(d("moderation.decide", { item: `r:${TH}:${RP}`, decision: "shown", base: { rev: 1 } }), {
    kind: "show",
    title: "Show bram’s reply in Sablefield",
  });
  t.like(d("moderation.decide", { item: `r:${TH}:${RP}`, decision: "hidden" }), {
    kind: "hide",
    title: "Hide a reply by bram in Sablefield",
    noun: "moderation action",
  });
  t.like(d("joinRequests.decide", { space: SP, users: ["noor.a"], decision: "approve" }), {
    kind: "approve",
    title: "Approve noor.a’s request in Sablefield",
  });
});

test("each state has the mockup's copy and actions (sxStatus)", (t) => {
  const o = (state: OutboxEntry["state"], extra: Partial<OutboxEntry> = {}): ObItem =>
    describe(
      entry("research.createPostFollowUp", { thread: TH, t: "Hi" }, { state, ...extra }),
      reader,
      label,
      NOW,
    );
  t.deepEqual(statusOf(o("queued"), { ...here, offline: true }), {
    tone: "wait",
    head: null,
    text: "Not sent yet: offline. It is saved on this Mac and sends when the connection is back.",
    acts: [],
  });
  t.is(statusOf(o("queued"), here).text, "Not sent yet: it sends after the changes before it.");
  const retry = statusOf(o("queued", { tries: 3, next: NOW + 4000 }), here);
  t.is(retry.text, "Not sent yet: the server didn’t answer. Next try in 4 s (try 3 of 5).");
  t.deepEqual(retry.acts, [["Retry now", "retryNow", true]]);
  t.is(
    statusOf(o("held"), here).text,
    "Not sent yet: this version of Session can’t sync. It sends after the update.",
  );
  const failed = statusOf(
    o("failed", { error: { code: "SERVICE_UNAVAILABLE", message: "" } }),
    here,
  );
  t.is(failed.head, "Couldn’t save");
  t.is(
    failed.text,
    "The server failed 5 times (server unavailable). The changes after it were sent.",
  );
  t.deepEqual(
    failed.acts.map((a) => a[0]),
    ["Retry", "Copy text", "Discard"],
  );
  const expired = statusOf(o("expired", { mutationId: "01M76A0000AAAAAAAAAAAAAAAA" }), {
    ...here,
    now: Date.UTC(2026, 10, 16) + 5 * DAY,
  });
  t.is(expired.head, "Not saved");
  t.regex(
    expired.text,
    /^The server takes a change up to 4 days after it was made, by this Mac’s clock\. This one was made \d+ days ago\.$/,
  );
  t.deepEqual(
    expired.acts.map((a) => a[0]),
    ["Send again", "Copy text", "Discard"],
  );
  const dropped = statusOf(o("dropped"), here);
  t.is(dropped.head, "Not sent");
  t.is(
    dropped.text,
    "It waited 3 days without reaching the server, so Session removed it from Unsent changes.",
  );
  t.deepEqual(dropped.acts, [
    ["Copy text", "copy", true],
    ["Dismiss", "discard", false],
  ]);
  const forbidden = statusOf(o("refused", { error: { code: "FORBIDDEN", message: "" } }), here);
  t.like(forbidden, { head: "Not applied", text: "The server refused it." });
  // a write with text keeps it: Copy text first
  t.deepEqual(
    forbidden.acts.map((a) => a[0]),
    ["Copy text", "Dismiss"],
  );
  const page = describe(
    entry(
      "pages.update",
      { space: SP, page: PG, title: "Canon", text: ["One"], base: { rev: 0 } },
      {
        state: "refused",
        error: { code: "CONFLICT", message: "", current: { ed: "tomasz" } as never },
      },
    ),
    reader,
    label,
    NOW,
  );
  t.like(statusOf(page, here), {
    head: "Not saved",
    text: "tomasz saved the page after you edited it on this Mac.",
  });
  t.deepEqual(
    statusOf(page, here).acts.map((a) => a[0]),
    ["Open the editor", "Copy text"],
  );
  t.is(
    listHead({ here: "this Mac", offline: false, update: false }),
    "Changes made on this Mac are sent to the server in the order they were made.",
  );
  t.is(
    listHead({ here: "this Mac", offline: true, update: false }),
    "Offline. These changes are saved on this Mac and are sent in this order when the connection is back.",
  );
  t.is(
    listHead({ here: "this Mac", offline: false, update: true }),
    "This version of Session can’t sync. These changes are saved on this Mac and are sent after the update.",
  );
});

// ---- a session that keeps its outbox ----

const member = rec({
  kind: "member",
  sp: SP,
  u: "ines.v",
  role: "member",
  adm: "01M2JF0CG0XJE5HTJDDTSNRY1H",
  joinedAt: "2026-09-20T12:00:00Z",
  rev: 1,
});
const keyOf = (r: StoredRecord) => {
  const x = r as unknown as Record<string, unknown>;
  return r.kind === "member"
    ? `member:${String(x["sp"])}:${String(x["u"])}`
    : `${r.kind}:${String(x["id"])}`;
};

function transport(push: (e: Envelope) => PushResult, call?: Transport["call"]) {
  const pushed: Envelope[] = [];
  const t: Transport = {
    register: () => Promise.resolve({ ok: true, clientId: "c1", serverTime: NOW }),
    push: (es) => Promise.resolve(es.map((e) => (pushed.push(e), push(e)))),
    snapshot: (log: LogId) =>
      Promise.resolve({
        records: (log === "user:ines.v"
          ? [member]
          : [RECORDS[`space:${SP}`] as StoredRecord, member]
        ).map((r) => ({ key: keyOf(r), record: r })),
        cursor: `${log}:0`,
        lastSeq: 0,
        serverTime: NOW,
      }),
    pull: (_log: LogId, cursor: string) =>
      Promise.resolve({
        changes: [] as Change[],
        cursor: `${cursor}+`,
        lastSeq: 0,
        serverTime: NOW,
      }),
    listen: (_c: () => CursorMap, _e, signal) =>
      new Promise<void>((r) => signal.addEventListener("abort", () => r())),
    call: call ?? (() => Promise.resolve({ ok: true, result: null, serverTime: NOW })),
  };
  return { t, pushed };
}

function Probe({ name, input, out }: { name: string; input: unknown; out: (o: Outcome) => void }) {
  const write = useWrite();
  return (
    <button type="button" onClick={() => void write(name, input).then(out)}>
      Write
    </button>
  );
}

function kept(
  push: (e: Envelope) => PushResult,
  storage = new MemoryStorage(),
  call?: Transport["call"],
) {
  setFetch(
    createFetchStub({ "GET /api/spaces": { spaces: [], stats: [], serverTime: NOW } }).fetch,
  );
  const { t, pushed } = transport(push, call);
  const session = new SpacesSession("ines.v", {
    transport: t,
    persist: true,
    storage,
    listen: false,
  });
  meResource.set(testUser({ handle: "ines.v", u: "ines.v" }));
  return { session, pushed, storage };
}

test.serial(
  "useWrite on a session that keeps its outbox: a write without an answer waits there, and the screen goes on",
  async (t) => {
    const { session } = kept(() => NO_RESPONSE);
    let out: Outcome | null = null;
    render(
      <SpacesProvider make={() => session}>
        <Probe name="likes.set" input={{ thread: TH, on: true }} out={(o) => (out = o)} />
      </SpacesProvider>,
    );
    await waitUntil(t, () => session.status().ready, "the session started");
    await act(async () => {
      screen.getByRole("button", { name: "Write" }).click();
      await new Promise((r) => setTimeout(r, 30));
    });
    await waitUntil(t, () => out !== null, "the screen went on");
    t.deepEqual(out, { ok: true, result: null, queued: true });
    const e = session.client?.outbox()[0];
    t.is(e?.state, "queued");
    t.false(isAwaited(e?.local ?? ""));
    meResource.reset();
    session.stop();
  },
);

test.serial(
  "useWrite on a session that keeps its outbox: an answer the screen waited for is the screen's",
  async (t) => {
    const { session } = kept(() => ({
      ok: false,
      error: { code: "FORBIDDEN", message: "No." },
      seq: 1,
      serverTime: NOW,
    }));
    let out: Outcome | null = null;
    render(
      <SpacesProvider make={() => session}>
        <Probe name="likes.set" input={{ thread: TH, on: true }} out={(o) => (out = o)} />
        <Toasts />
      </SpacesProvider>,
    );
    await waitUntil(t, () => session.status().ready, "the session started");
    await act(async () => {
      screen.getByRole("button", { name: "Write" }).click();
      await new Promise((r) => setTimeout(r, 30));
    });
    await waitUntil(t, () => out !== null, "the write ended");
    t.like(out, { ok: false, error: { code: "FORBIDDEN" } });
    t.truthy(screen.getByText(WRITE_ERROR["FORBIDDEN"] ?? "-"));
    // shown once, by the screen: the outbox forgets it
    t.deepEqual(session.client?.outbox(), []);
    meResource.reset();
    session.stop();
  },
);

test.serial(
  "the writes an earlier run of the app left in the outbox are sent when the session starts",
  async (t) => {
    const storage = new MemoryStorage();
    await storage.saveMeta({ user: "ines.v", clientId: "c1", lastSeq: 0, offset: 0 });
    await storage.saveOutbox([
      entry(
        "likes.set",
        { thread: TH, on: true },
        { mutationId: "01M7E1650000000000000000AA", queuedAt: NOW - 60_000 },
      ),
    ]);
    const { session, pushed } = kept(
      (e) => ({ ok: true, result: { on: true }, seq: e.seq, serverTime: NOW }),
      storage,
    );
    await session.start();
    await waitUntil(t, () => pushed.length === 1, "the stored write was sent");
    t.is(pushed[0]?.name, "likes.set");
    session.stop();
  },
);

test.serial("the web’s session keeps no outbox; the desktop platform's does", (t) => {
  setPlatform(null);
  t.false(new SpacesSession("ines.v", { listen: false }).persistent);
  setPlatform({ ...webPlatform, kind: "desktop", persist: true, here: "this Mac" });
  t.true(new SpacesSession("ines.v", { listen: false }).persistent);
});

// ---- phase 3 review round 1 (reviewer B) ----

test.serial(
  "useWrite on a session that keeps its outbox: an online-only call with no answer ends as on the web",
  async (t) => {
    // spaces.create is not a mutator: it is sent at once, never queued
    const { session } = kept(
      () => NO_RESPONSE,
      new MemoryStorage(),
      () => Promise.reject(new Offline("no response")),
    );
    let out: Outcome | null = null;
    render(
      <SpacesProvider make={() => session}>
        <Probe
          name="spaces.create"
          input={{ id: "01M7E1650000000000000000SP", name: "x", desc: "", rules: [], vis: "open" }}
          out={(o) => (out = o)}
        />
      </SpacesProvider>,
    );
    await waitUntil(t, () => session.status().ready, "the session started");
    await act(async () => {
      screen.getByRole("button", { name: "Write" }).click();
      await new Promise((r) => setTimeout(r, 30));
    });
    await waitUntil(t, () => out !== null, "the call ended");
    t.like(out, { ok: false, error: null });
    t.is(typeof (out as unknown as { local?: unknown }).local, "string");
    t.deepEqual(session.client?.outbox(), []);
    meResource.reset();
    session.stop();
  },
);

test("every write that holds the person's text keeps it for Copy text", (t) => {
  const d = (name: string, input: unknown) =>
    describe(
      entry(name, input, { state: "refused", error: { code: "FORBIDDEN", message: "" } }),
      reader,
      label,
      NOW,
    );
  const SK = "01M2JF0CG0SK00000000000001";
  t.like(d("skills.create", { space: SP, id: SK, name: "triage", prompt: "Sort the reports." }), {
    title: "New skill triage in Sablefield",
    noun: "skill",
    text: "triage\n\nSort the reports.",
  });
  t.like(
    d("skills.update", {
      space: SP,
      id: SK,
      name: "triage",
      prompt: "Sort them.",
      base: { rev: 0 },
    }),
    { title: "Edit of skill triage in Sablefield", text: "triage\n\nSort them." },
  );
  // spaces.update names its space as `id`
  t.like(
    d("spaces.update", {
      id: SP,
      set: {
        desc: "A description I wrote",
        rules: ["Rule one", "Rule two"],
        qs: [{ q: "Why join?" }],
      },
      base: { rulesRev: 0 },
    }),
    {
      space: SP,
      spaceLabel: "Sablefield",
      title: "Settings in Sablefield",
      noun: "settings change",
      text: "A description I wrote\n\nRule one\nRule two\n\nWhy join?",
    },
  );
  t.like(d("profile.update", { name: "Ines", bio: "A bio I wrote" }), {
    title: "Profile",
    text: "Ines\n\nA bio I wrote",
  });
  t.like(d("reports.create", { id: "x", item: `p:${TH}`, why: "spam", note: "A note I wrote" }), {
    title: "Report in Sablefield",
    noun: "report",
    text: "A note I wrote",
  });
  t.like(d("joinRequests.create", { space: SP, answers: ["First answer", "Second answer"] }), {
    title: "Request to join in Sablefield",
    text: "First answer\n\nSecond answer",
  });
  t.like(d("spaceSources.add", { space: SP, url: "https://a.example/x", note: "Why it matters" }), {
    text: "https://a.example/x\n\nWhy it matters",
  });
  // each of them offers Copy text
  for (const name of ["skills.create", "spaces.update", "profile.update", "reports.create"]) {
    const o = d(name, {
      space: SP,
      id: SP,
      name: "n",
      prompt: "p",
      bio: "b",
      note: "n",
      item: `p:${TH}`,
      set: { desc: "d" },
    });
    t.true(
      statusOf(o, here).acts.some((a) => a[1] === "copy"),
      name,
    );
  }
});

test("the moderation writes are mutators that need a moderator's role", (t) => {
  for (const name of MODERATION) t.not(pkg.MUTATORS.get(name), undefined, name);
  for (const name of [
    "reports.resolve",
    "spaceSources.review",
    "invites.restore",
    "invites.revoke",
  ])
    t.true(isModeration({ name }), name);
  t.false(isModeration({ name: "reports.decide" }));
  t.false(isModeration({ name: "research.createPostFollowUp" }));
});

test("a STALE write without text stays in the list with Dismiss, and says why", (t) => {
  const o = describe(
    entry(
      "moderation.decide",
      { item: `r:${TH}:${RP}`, decision: "shown", base: { rev: 1 } },
      { state: "refused", error: { code: "STALE", message: "" } },
    ),
    reader,
    label,
    NOW,
  );
  t.deepEqual(statusOf(o, here), {
    tone: "bad",
    head: "Not saved",
    text: "The item changed on the server after you made this change on this Mac, so the server didn’t apply the change.",
    acts: [["Dismiss", "discard", true]],
  });
});

test.serial(
  "toasts: a sticky toast stays until dismissed or no longer live; a toast over it goes first",
  async (t) => {
    let live = true;
    render(<Toasts />);
    await act(async () => {
      stickyToast({
        key: "ob:1",
        text: "Not applied: your reply in Sablefield.",
        live: () => live,
      });
      await Promise.resolve();
    });
    t.truthy(screen.getByText("Not applied: your reply in Sablefield."));
    await act(async () => {
      toast("Text copied.");
      await Promise.resolve();
    });
    t.truthy(screen.getByText("Text copied."));
    t.is(screen.queryByText("Not applied: your reply in Sablefield."), null);
    // a second toast replaces the first transient one; the sticky one waits
    await act(async () => {
      toast("Copied your edits.");
      await Promise.resolve();
    });
    await act(async () => {
      screen.getByRole("button", { name: "Dismiss" }).click();
      await Promise.resolve();
    });
    t.truthy(screen.getByText("Not applied: your reply in Sablefield."));
    // the same key replaces it
    await act(async () => {
      stickyToast({ key: "ob:1", text: () => "Next try in 3 s.", live: () => live });
      await Promise.resolve();
    });
    t.truthy(screen.getByText("Next try in 3 s."));
    t.is(screen.queryByText("Not applied: your reply in Sablefield."), null);
    // it goes once the write it names changed
    live = false;
    await act(async () => {
      pruneToasts();
      await Promise.resolve();
    });
    t.is(screen.queryByText("Next try in 3 s."), null);
  },
);

test.serial("savedToast: a write that waits in the outbox is not saved yet", async (t) => {
  render(<Toasts />);
  await act(async () => {
    savedToast({ ok: true, result: null, queued: true }, "Settings saved.");
    await Promise.resolve();
  });
  t.is(screen.queryByText("Settings saved."), null);
  await act(async () => {
    savedToast({ ok: false, error: { code: "FORBIDDEN", message: "" } }, "Settings saved.");
    await Promise.resolve();
  });
  t.is(screen.queryByText("Settings saved."), null);
  await act(async () => {
    savedToast({ ok: true, result: null }, "Settings saved.");
    await Promise.resolve();
  });
  t.truthy(screen.getByText("Settings saved."));
});
