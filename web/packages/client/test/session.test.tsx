// Phase 2 review round 1, findings 6 and 9: the in-flight answer text of the
// sync stream (`RunTexts`), the tab's session over a scripted transport
// (signed in and signed out: the run frames, the poke that brings the
// answer, and the text that goes with it), the `Reader` the screens query,
// and `useWorld`.

import type {
  Change,
  CursorMap,
  LogId,
  SseEvent,
  StoredRecord,
  Transport,
} from "@session/sync/client";
import { act, cleanup, render, screen } from "@testing-library/react";
import test from "ava";

import { meResource } from "../src/api/account.js";
import { setFetch } from "../src/api/http.js";
import { useWorld } from "../src/spaces/world.js";
import { Reader, mapSource } from "../src/sync/reader.js";
import { SpacesProvider, useRunText } from "../src/sync/react.js";
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
function scripted(logs: Record<string, StoredRecord[]>) {
  const queued = new Map<string, Change[]>();
  const reads: string[] = [];
  let emit: ((e: SseEvent) => void) | null = null;
  const listening: (() => void)[] = [];
  const t: Transport = {
    register: () => Promise.resolve({ ok: true, clientId: "c1", serverTime: NOW }),
    push: (es) => Promise.resolve(es.map(() => ({ ok: true, result: null, serverTime: NOW }))),
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
  r.add({ run: "R", attempt: 1, seq: 4, text: "." });
  t.is(r.get("R"), "Shortlist.");
  t.is(calls, 2);
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
