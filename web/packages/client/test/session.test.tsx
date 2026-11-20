// Phase 2 review round 1, findings 6 and 9: the in-flight answer text of the
// sync stream (`RunTexts`), the tab's session over a scripted transport
// (signed in and signed out: the run frames, the poke that brings the
// answer, and the text that goes with it), the `Reader` the screens query,
// and `useWorld`.

import type {
  PushResult,
  Change,
  CursorMap,
  Envelope,
  LogId,
  SseEvent,
  StoredRecord,
  Transport,
} from "@session/sync/client";
import { act, cleanup, render, screen } from "@testing-library/react";
import test, { type ExecutionContext } from "ava";

import { meResource } from "../src/api/account.js";
import { setFetch } from "../src/api/http.js";
import { useWorld } from "../src/spaces/world.js";
import {
  Toasts,
  WRITE_ERROR,
  useCreate,
  useWrite,
  type CreateOutcome,
  type Outcome,
} from "../src/spaces/writes.js";
import { SpacesProvider, useRunText } from "../src/sync/react.js";
import { Reader, mapSource } from "../src/sync/reader.js";
import { RunTexts, SpacesSession } from "../src/sync/session.js";

import { createFetchStub } from "./fetchStub.js";
import { testUser, waitUntil } from "./helpers.js";

test.afterEach(() => cleanup());

const NOW = Date.parse("2026-11-16T10:00:00Z");
const SP = "01M2JF0CG0TEZ9AAQXTPES96AH";
const TH = "01M7HWS7800000000000000001";
const RUN = "01M2JF0CG01A4NX20DH2FBJJKV";
const LAB = "01M2JF0CG0HAY5X22N9TH1R2N1";

const rec = (r: Record<string, unknown>) => r as unknown as StoredRecord;
const keyOf = (r: StoredRecord) => {
  const x = r as unknown as Record<string, unknown>;
  if (r.kind === "member") return `member:${String(x["sp"])}:${String(x["u"])}`;
  if (r.kind === "counts") return `counts:${String(x["th"])}`;
  return `${r.kind}:${String(x["id"])}`;
};

const space = rec({
  kind: "space",
  id: SP,
  name: "public",
  title: "Public",
  desc: "",
  rules: [],
  vis: "open",
  deleted: false,
  archived: null,
  members: 2,
  createdAt: "2026-09-01T00:00:00Z",
  rev: 1,
});
const member = (u: string, role = "member") =>
  rec({
    kind: "member",
    sp: SP,
    u,
    role,
    adm: "01M2JF0CG0XJE5HTJDDTSNRY1H",
    joinedAt: "2026-09-20T12:00:00Z",
    rev: 1,
  });
const thread = rec({
  kind: "thread",
  id: TH,
  s: SP,
  u: "raymond",
  k: "ask",
  q: "What changed in public guidance on AI model evaluations this year?",
  t: null,
  sum: null,
  tok: 0,
  running: true,
  edited: false,
  del: false,
  gone: false,
  mod: null,
  topic: null,
  topicBy: null,
  pay: "session",
  model: null,
  about: null,
  skill: null,
  att: 1,
  from: null,
  createdAt: "2026-11-16T09:58:30Z",
  updatedAt: "2026-11-16T09:58:30Z",
  rev: 1,
});
const counts = rec({ kind: "counts", th: TH, s: SP, likes: 0, r: 0, rlikes: {}, rev: 1 });
const run = (status: string) =>
  rec({
    kind: "run",
    id: RUN,
    th: TH,
    s: SP,
    u: "raymond",
    node: "r",
    status,
    end: null,
    attempt: 1,
    pay: "session",
    model: null,
    executor: null,
    createdAt: "2026-11-16T09:58:30Z",
    rev: status === "running" ? 1 : 2,
  });

/** A transport over logs held here: a snapshot serves a log's records, a
 * pull the changes queued for it, and the stream the events a test emits. */
function scripted(
  logs: Record<string, StoredRecord[]>,
  o: { push?: (e: Envelope) => PushResult } = {},
) {
  const queued = new Map<string, Change[]>();
  const reads: string[] = [];
  let emit: ((e: SseEvent) => void) | null = null;
  const listening: (() => void)[] = [];
  const t: Transport = {
    register: () => Promise.resolve({ ok: true, clientId: "c1", serverTime: NOW }),
    push: (es) =>
      Promise.resolve(
        es.map((e) => (o.push ? o.push(e) : { ok: true as const, result: null, serverTime: NOW })),
      ),
    snapshot: (log: LogId) => {
      reads.push(`snapshot ${log}`);
      return Promise.resolve({
        records: (logs[log] ?? []).map((r) => ({ key: keyOf(r), record: r })),
        cursor: `${log}:0`,
        lastSeq: 0,
        serverTime: NOW,
      });
    },
    pull: (log: LogId, cursor: string) => {
      reads.push(`pull ${log}`);
      const changes = queued.get(log) ?? [];
      queued.delete(log);
      return Promise.resolve({ changes, cursor: `${cursor}+`, lastSeq: 0, serverTime: NOW });
    },
    listen: (_c: () => CursorMap, onEvent, signal) => {
      emit = onEvent;
      for (const l of listening.splice(0)) l();
      return new Promise<void>((r) => signal.addEventListener("abort", () => r()));
    },
    call: () => Promise.resolve({ ok: true, result: null, serverTime: NOW }),
  };
  return {
    transport: t,
    reads,
    /** The changes the next pull of `log` serves. */
    change(log: string, ...cs: Change[]) {
      queued.set(log, [...(queued.get(log) ?? []), ...cs]);
    },
    /** An event on the stream, once it is open. */
    async emit(e: SseEvent) {
      if (!emit) await new Promise<void>((r) => listening.push(r));
      emit?.(e);
    },
  };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

function directoryFetch() {
  const stub = createFetchStub({
    "GET /api/spaces": { spaces: [space], stats: [], serverTime: NOW },
  });
  setFetch(stub.fetch);
  return stub;
}

// ---- RunTexts ----

test("RunTexts: frames in seq order add up; one at or below the last seq is dropped", (t) => {
  const r = new RunTexts();
  let calls = 0;
  const stop = r.onChange(() => calls++);
  r.add({ run: "R", attempt: 1, seq: 1, text: "Short" });
  r.add({ run: "R", attempt: 1, seq: 2, text: "list" });
  t.is(r.get("R"), "Shortlist");
  t.is(calls, 2);
  const v = r.version();
  r.add({ run: "R", attempt: 1, seq: 2, text: " again" });
  r.add({ run: "R", attempt: 1, seq: 1, text: " older" });
  t.is(r.get("R"), "Shortlist");
  t.is(r.version(), v);
  t.is(calls, 2);
  stop();
  r.add({ run: "R", attempt: 1, seq: 3, text: "." });
  t.is(r.get("R"), "Shortlist.");
  t.is(calls, 2);
});

// review round 2 of phase 2, finding 6 (reviewer B's runtexts-gap): a frame
// carries only the text since the frame before, so a reader shows text only
// while it has every frame of the attempt
const FRAMES = ["Three novels ", "treat agents ", "bargaining for ", "their owners."];

test("RunTexts: a gap in seq drops the text, and later frames of the attempt add none", (t) => {
  const r = new RunTexts();
  let calls = 0;
  r.onChange(() => calls++);
  r.add({ run: "R", attempt: 1, seq: 1, text: FRAMES[0] ?? "" });
  r.add({ run: "R", attempt: 1, seq: 2, text: FRAMES[1] ?? "" });
  t.is(r.get("R", 1), "Three novels treat agents ");
  // the stream reconnected and missed seq 3
  r.add({ run: "R", attempt: 1, seq: 4, text: FRAMES[3] ?? "" });
  t.is(r.get("R", 1), null);
  t.is(calls, 3);
  r.add({ run: "R", attempt: 1, seq: 5, text: " More." });
  t.is(r.get("R", 1), null);
  // nothing shown changed
  t.is(calls, 3);
  // Run again: a new attempt from seq 1 shows its text
  r.add({ run: "R", attempt: 2, seq: 1, text: "Again." });
  t.is(r.get("R", 2), "Again.");
});

test("RunTexts: a reader that joins mid-run shows no text for that attempt", (t) => {
  const r = new RunTexts();
  r.add({ run: "R", attempt: 1, seq: 3, text: FRAMES[2] ?? "" });
  t.is(r.get("R", 1), null);
  r.add({ run: "R", attempt: 1, seq: 4, text: FRAMES[3] ?? "" });
  t.is(r.get("R", 1), null);
  // a later attempt's first frame is not at seq 1 either: none
  r.add({ run: "R", attempt: 2, seq: 2, text: "late" });
  t.is(r.get("R", 2), null);
});

test("RunTexts: a server run resumed after a restart (seq jumps above the last) drops the text before it", (t) => {
  const r = new RunTexts();
  for (let s = 1; s <= 73; s++)
    r.add({ run: "R", attempt: 1, seq: s, text: s === 73 ? "half a sent" : "x" });
  t.is(r.get("R", 1)?.endsWith("half a sent"), true);
  // the resumed loop continues above every seq it sent before (the server
  // starts above the last persisted seq plus the persist interval)
  r.add({ run: "R", attempt: 1, seq: 101, text: "The answer again." });
  t.is(r.get("R", 1), null);
  r.add({ run: "R", attempt: 1, seq: 102, text: " More." });
  t.is(r.get("R", 1), null);
  // replays of frames before the restart change nothing
  r.add({ run: "R", attempt: 1, seq: 74, text: "late" });
  t.is(r.get("R", 1), null);
});

test("RunTexts: a newer attempt starts over, an older one is dropped, and get names the attempt", (t) => {
  const r = new RunTexts();
  r.add({ run: "R", attempt: 1, seq: 5, text: "first try" });
  r.add({ run: "R", attempt: 2, seq: 1, text: "second" });
  t.is(r.get("R"), "second");
  t.is(r.get("R", 2), "second");
  t.is(r.get("R", 1), null);
  r.add({ run: "R", attempt: 1, seq: 9, text: " late" });
  t.is(r.get("R"), "second");
  t.is(r.get("other"), null);
});

test("RunTexts: drop takes a run's text away once, telling the listeners", (t) => {
  const r = new RunTexts();
  let calls = 0;
  r.onChange(() => calls++);
  r.add({ run: "R", attempt: 1, seq: 1, text: "x" });
  r.drop("R");
  t.is(r.get("R"), null);
  t.is(calls, 2);
  r.drop("R");
  t.is(calls, 2);
});

// ---- Reader ----

test("Reader: lists a kind by creation time, gets by kind and id, and says what is pending", (t) => {
  const a = rec({ kind: "thread", id: "B", s: SP, createdAt: "2026-11-02T00:00:00Z", rev: 1 });
  const b = rec({ kind: "thread", id: "A", s: SP, createdAt: "2026-11-01T00:00:00Z", rev: 1 });
  const src = mapSource([a, b, space, member("raymond")]);
  const r = new Reader({ ...src, pendingAt: (k) => k === "thread:B" }, "raymond");
  t.deepEqual(
    r.list("thread").map((x) => x.id),
    ["A", "B"],
  );
  t.deepEqual(
    r.list("thread", (x) => x.id === "B").map((x) => x.id),
    ["B"],
  );
  t.is(r.get("thread", "A")?.id, "A");
  // a key of another kind is not the record asked for
  t.is(r.get("space", "A"), undefined);
  t.is(r.byKey(`space:${SP}`)?.kind, "space");
  t.true(r.pending("thread:B"));
  t.false(r.pending("thread:A"));
  t.is(r.me, "raymond");
  t.deepEqual(r.list("run"), []);
});

// ---- SpacesSession ----

test.serial(
  "SpacesSession signed in: opens the user log and the joined spaces, shows run frames, and drops the text when the run ends",
  async (t) => {
    directoryFetch();
    const s = scripted({
      "user:raymond": [member("raymond")],
      [`space:${SP}`]: [space, member("raymond"), thread, counts, run("running")],
    });
    const session = new SpacesSession("raymond", { transport: s.transport });
    await session.start();
    t.true(session.status().ready);
    t.true(s.reads.includes("snapshot user:raymond"));
    t.true(s.reads.includes(`snapshot space:${SP}`));
    t.is(session.reader().get("run", RUN)?.status, "running");
    await s.emit({ type: "run", run: RUN, attempt: 1, seq: 1, text: "Shortlist so far" });
    await s.emit({ type: "run", run: RUN, attempt: 1, seq: 1, text: " AGAIN" });
    await s.emit({ type: "run", run: RUN, attempt: 1, seq: 2, text: ", newest first." });
    t.is(session.runs.get(RUN, 1), "Shortlist so far, newest first.");
    // the answer arrives: a poke, and the pull brings the run's end
    s.change(`space:${SP}`, { key: `run:${RUN}`, op: "put", record: run("complete") });
    await s.emit({ type: "poke", logs: [`space:${SP}`] });
    await settle();
    t.is(session.reader().get("run", RUN)?.status, "complete");
    t.is(session.runs.get(RUN), null);
    session.stop();
  },
);

test.serial(
  "SpacesSession signed out: a guest sees run frames of a space it shows, and the text goes when the run ends",
  async (t) => {
    directoryFetch();
    const s = scripted({ [`space:${SP}`]: [space, thread, counts, run("running")] });
    const session = new SpacesSession(null, { transport: s.transport });
    await session.start();
    await session.showSpace(SP);
    t.is(session.reader().get("run", RUN)?.status, "running");
    await s.emit({ type: "run", run: RUN, attempt: 1, seq: 1, text: "Text " });
    await s.emit({ type: "run", run: RUN, attempt: 1, seq: 2, text: "so far" });
    t.is(session.runs.get(RUN, 1), "Text so far");
    s.change(`space:${SP}`, { key: `run:${RUN}`, op: "put", record: run("complete") });
    await s.emit({ type: "poke", logs: [`space:${SP}`] });
    await settle();
    t.is(session.reader().get("run", RUN)?.status, "complete");
    t.is(session.runs.get(RUN), null);
    session.stop();
  },
);

test.serial("useRunText follows a run's text, and a null run reads none", async (t) => {
  directoryFetch();
  const s = scripted({
    "user:raymond": [member("raymond")],
    [`space:${SP}`]: [space, member("raymond"), thread, counts, run("running")],
  });
  const session = new SpacesSession("raymond", { transport: s.transport });
  meResource.set(testUser());
  function Probe({ id }: { id: string | null }) {
    const text = useRunText(id, 1);
    return <p data-testid={id ?? "none"}>{text ?? "(none)"}</p>;
  }
  render(
    <SpacesProvider make={() => session}>
      <Probe id={RUN} />
      <Probe id={null} />
    </SpacesProvider>,
  );
  await waitUntil(t, () => session.status().ready, "the session started");
  await act(() => s.emit({ type: "run", run: RUN, attempt: 1, seq: 1, text: "Hello" }));
  await waitUntil(t, () => screen.getByTestId(RUN).textContent === "Hello", "the text shows");
  t.is(screen.getByTestId("none").textContent, "(none)");
  meResource.reset();
});

// ---- useWorld ----

test.serial(
  "useWorld: the directory's spaces with the replica's, and the person's roles",
  async (t) => {
    directoryFetch();
    const closed = rec({
      ...(space as unknown as Record<string, unknown>),
      id: LAB,
      name: "lab",
      vis: "listed",
    });
    const s = scripted({
      "user:raymond": [
        member("raymond", "mod"),
        rec({ ...(member("raymond") as unknown as Record<string, unknown>), sp: LAB }),
      ],
      [`space:${SP}`]: [space, member("raymond", "mod")],
      [`space:${LAB}`]: [closed],
    });
    const session = new SpacesSession("raymond", { transport: s.transport });
    meResource.set(testUser());
    function Probe() {
      const w = useWorld();
      return (
        <p data-testid="w">
          {JSON.stringify({
            me: w.me?.u ?? null,
            loaded: w.loaded,
            spaces: w.spaces.map((x) => x.name).sort(),
            roles: w.roles,
          })}
        </p>
      );
    }
    render(
      <SpacesProvider make={() => session}>
        <Probe />
      </SpacesProvider>,
    );
    const read = () =>
      JSON.parse(screen.getByTestId("w").textContent ?? "{}") as {
        me: string | null;
        loaded: boolean;
        spaces: string[];
        roles: Record<string, string>;
      };
    await waitUntil(
      t,
      () => read().loaded && read().spaces.length === 2,
      "the directory and the replica answered",
    );
    const w = read();
    t.is(w.me, "raymond");
    t.deepEqual(w.spaces, ["lab", "public"]);
    t.deepEqual(w.roles, {
      [SP]: "mod",
      [LAB]: "member",
    });
    meResource.reset();
    session.stop();
  },
);

// ---- the write budget's refusal ----

test.serial(
  "a write the server's budget refuses (TOO_MANY_REQUESTS, unrecorded) shows the mockup's toast and is not offered again",
  async (t) => {
    directoryFetch();
    const s = scripted(
      {
        "user:raymond": [member("raymond")],
        [`space:${SP}`]: [space, member("raymond"), thread, counts],
      },
      {
        push: () => ({
          ok: false,
          error: {
            code: "TOO_MANY_REQUESTS",
            message: "Too many changes.",
            retryAt: "2026-11-16T10:00:10Z",
          },
          serverTime: NOW,
        }),
      },
    );
    const session = new SpacesSession("raymond", { transport: s.transport });
    meResource.set(testUser());
    let outcome: Outcome | null = null;
    function Probe() {
      const write = useWrite();
      return (
        <button
          type="button"
          onClick={() =>
            void write("likes.set", { thread: TH, on: true }).then((o) => (outcome = o))
          }
        >
          Like
        </button>
      );
    }
    render(
      <SpacesProvider make={() => session}>
        <Probe />
        <Toasts />
      </SpacesProvider>,
    );
    await waitUntil(t, () => session.status().ready, "the session started");
    await act(async () => {
      screen.getByRole("button", { name: "Like" }).click();
      await settle();
    });
    await waitUntil(t, () => outcome !== null, "the write ended");
    t.like(outcome, { ok: false, error: { code: "TOO_MANY_REQUESTS" } });
    t.truthy(screen.getByText(WRITE_ERROR["TOO_MANY_REQUESTS"] ?? "-"));
    // refused, not waiting for Try again
    t.deepEqual(session.client?.problems(), []);
    meResource.reset();
    session.stop();
  },
);

// ---- a create sent again (review round 2 of phase 2, finding 2) ----

/** A create whose first envelope got no answer, sent again with `second`:
 * the server answers the second envelope from the first (`earlier`) or
 * applies the second. */
async function lostThenAgain(
  t: ExecutionContext,
  first: Record<string, unknown>,
  second: Record<string, unknown>,
  earlier: boolean,
): Promise<{ out: CreateOutcome; sent: Envelope[] }> {
  directoryFetch();
  const sent: Envelope[] = [];
  const s = scripted(
    {
      "user:raymond": [member("raymond")],
      [`space:${SP}`]: [space, member("raymond"), thread, counts],
    },
    {
      push: (e) => {
        sent.push(e);
        if (sent.length === 1) return null;
        const firstId = sent[0]?.mutationId ?? "";
        return earlier
          ? { ok: true, result: null, serverTime: NOW, replayed: true, recordedAs: firstId }
          : { ok: true, result: null, serverTime: NOW };
      },
    },
  );
  const session = new SpacesSession("raymond", { transport: s.transport, listen: false });
  meResource.set(testUser());
  let create: ReturnType<typeof useCreate> | null = null;
  function Probe() {
    create = useCreate();
    return null;
  }
  render(
    <SpacesProvider make={() => session}>
      <Probe />
    </SpacesProvider>,
  );
  await waitUntil(t, () => session.status().ready, "the session started");
  const send = async (input: Record<string, unknown>) => {
    let out: CreateOutcome | null = null;
    await act(async () => {
      out = (await create?.send("threads.create", (id) => ({ id, ...input }))) ?? null;
    });
    return out as unknown as CreateOutcome;
  };
  const lost = await send(first);
  t.like(lost, { ok: false, error: null });
  const out = await send(second);
  meResource.reset();
  session.stop();
  return { out, sent };
}

const POST = { space: SP, kind: "post", q: "Notes from Thursday are on the wiki page." };

test.serial(
  "a create sent again with another space or kind, answered from the first envelope, reports lost edits",
  async (t) => {
    const other = { ...POST, kind: "ask", pay: "session" };
    const { out, sent } = await lostThenAgain(t, POST, other, true);
    t.like(out, { ok: true, lostEdits: true });
    // the same create: one id, the second envelope replaces the first
    t.is(sent.length, 2);
    t.is((sent[1]?.input as { id: string }).id, (sent[0]?.input as { id: string }).id);
    t.deepEqual(sent[1]?.replaces, [sent[0]?.mutationId]);
    const moved = { ...POST, space: LAB };
    t.like((await lostThenAgain(t, POST, moved, true)).out, { ok: true, lostEdits: true });
  },
);

test.serial(
  "a create sent again unchanged, or applied by the second envelope, reports no lost edits",
  async (t) => {
    t.like((await lostThenAgain(t, POST, POST, true)).out, { ok: true, lostEdits: false });
    const other = { ...POST, kind: "ask", pay: "session" };
    t.like((await lostThenAgain(t, POST, other, false)).out, { ok: true, lostEdits: false });
  },
);

// ---- a space just made (2b design finding 6) ----

test.serial("a space spaces.create answered is in the directory at once", async (t) => {
  directoryFetch();
  const s = scripted({ "user:raymond": [] });
  const session = new SpacesSession("raymond", { transport: s.transport });
  await session.start();
  await session.directory.load();
  t.deepEqual(
    session.directory.get().data?.spaces.map((x) => x.name),
    ["public"],
  );
  const made = rec({
    ...(space as unknown as Record<string, unknown>),
    id: "01M2JF0CG0ZZZZZZZZZZZZZZZZ",
    name: "field-recordings",
  });
  session.addSpace(made as never);
  t.deepEqual(
    session.directory.get().data?.spaces.map((x) => x.name),
    ["public", "field-recordings"],
  );
  // the same space again replaces it
  session.addSpace(made as never);
  t.is(session.directory.get().data?.spaces.length, 2);
  session.stop();
});
