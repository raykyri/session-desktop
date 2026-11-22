// The client half (`01` Y9-Y11, R2-R4) against the server half on the
// in-memory store: what the plan adds to the prototype's client suite
// (backoff, failure and the 3-day drop run in replica-proto's review-r2 on
// this client, with the `queue` policy).

import { MUTATORS } from "@session/mutators";
import test from "ava";

import {
  MemoryAdapter,
  SyncClient,
  type ApplyResult,
  type ClientEvent,
  type SyncTransport,
} from "../src/client/index.js";

import { DAY, MINUTE, MODEL, World, cast, ok, post } from "./world.js";

const client = (w: World, u: string, transport: SyncTransport = w.transport(u)) =>
  new SyncClient(transport, {
    user: u,
    clock: w.clock,
    random: w.random,
    mutators: MUTATORS,
    storage: new MemoryAdapter(),
  });

/** A transport whose writes fail while `down` is set (no answer). */
function flaky(w: World, u: string) {
  const base = w.transport(u);
  const state = { down: false };
  const transport: SyncTransport = {
    register: (o) => base.register(o),
    snapshot: (l, o) => base.snapshot(l, o),
    pull: (l, c, o) => base.pull(l, c, o),
    apply: (e) => {
      if (state.down) throw new Error("offline");
      return base.apply(e);
    },
  };
  return { transport, state };
}

const events = (c: SyncClient) => {
  const out: ClientEvent[] = [];
  c.onEvent((e) => out.push(e));
  return out;
};

test("Y9-Y11: a write is shown at once, confirmed by the server, and the view equals the server's", async (t) => {
  const { w, open } = cast(t);
  const p = post(t, w, "mel", open);
  const mona = client(w, "mona");
  await mona.sync(`space:${open}`);
  await mona.sync("user:mona");
  const id = w.id();
  const reply = mona.queue("research.createPostFollowUp", { id, thread: p, t: "a reply" });
  // predicted before it is sent: the reply, the count
  t.like(mona.get(`reply:${id}`), { t: "a reply", u: "mona" });
  t.like(mona.get(`counts:${p}`), { r: 1 });
  t.is(mona.prediction(reply.local), "applied");
  t.is(mona.records(`space:${open}`).get(`reply:${id}`), undefined, "not confirmed yet");
  await mona.flush();
  // applied: still shown until the replica has read it
  t.like(mona.get(`reply:${id}`), { t: "a reply" });
  await mona.sync(`space:${open}`);
  await mona.sync("user:mona");
  t.deepEqual(mona.get(`reply:${id}`), w.get(`reply:${id}`));
  t.deepEqual(mona.get(`counts:${p}`), w.get(`counts:${p}`));
  t.deepEqual(mona.prediction(reply.local), undefined);
});

test("Y11: a refused write is rolled back and its input returned for the composer", async (t) => {
  const { w, open } = cast(t);
  const p = post(t, w, "mel", open);
  const otto = client(w, "otto");
  await otto.sync(`space:${open}`);
  const seen = events(otto);
  ok(t, w.as("olga", "members.ban", { space: open, user: "otto" }));
  // the replica holds no ban: the reply is predicted, and the server refuses it
  const id = w.id();
  otto.queue("research.createPostFollowUp", { id, thread: p, t: "my draft" });
  t.truthy(otto.get(`reply:${id}`));
  await otto.flush();
  t.is(otto.get(`reply:${id}`), undefined);
  t.like(
    seen.find((e) => e.type === "refused"),
    { type: "refused", input: { t: "my draft" }, error: { code: "FORBIDDEN" } },
  );
});

test("Y10: the in-flight policy: a failed request leaves the write Not sent, nothing queued; Retry keeps its mutation id, Discard rolls back", async (t) => {
  const { w, open } = cast(t);
  const p = post(t, w, "mel", open);
  const { transport, state } = flaky(w, "otto");
  const otto = client(w, "otto", transport);
  await otto.sync(`space:${open}`);
  await otto.sync("user:otto");
  await otto.register();
  const seen = events(otto);
  state.down = true;
  const save = otto.queue("saved.set", { kind: "thread", id: p, on: true });
  const reply = w.id();
  const r = otto.queue("research.createPostFollowUp", { id: reply, thread: p, t: "kept" });
  await otto.flush();
  t.deepEqual(otto.pending(), [], "nothing is queued");
  t.deepEqual(
    otto.unsent().map((x) => x.local),
    [save.local, r.local],
  );
  t.deepEqual(
    seen.filter((e) => e.type === "unsent").map((e) => (e.type === "unsent" ? e.local : "")),
    [save.local, r.local],
  );
  // the predictions stay
  t.truthy(otto.get(`save:otto:${p}`));
  t.truthy(otto.get(`reply:${reply}`));
  // Retry: the same mutation id
  state.down = false;
  const before = otto.sent.filter((e) => e.name === "saved.set").map((e) => e.mutationId);
  await otto.retry(save.local);
  const after = otto.sent.filter((e) => e.name === "saved.set").map((e) => e.mutationId);
  t.is(new Set([...before, ...after]).size, 1);
  t.like(w.get(`save:otto:${p}`), { u: "otto" });
  // Discard: rolled back, and the server never got it
  t.true(otto.discard(r.local));
  t.is(otto.get(`reply:${reply}`), undefined);
  t.is(w.get(`reply:${reply}`), undefined);
  t.truthy(seen.find((e) => e.type === "discarded"));
});

test("Y10: EXPIRED is shown, CLOCK_SKEW corrects the clock and remints, TOO_LARGE leaves the write Not sent", async (t) => {
  const { w, open } = cast(t);
  const p = post(t, w, "mel", open);
  const slow = { now: () => w.clock.now() - 10 * MINUTE };
  const otto = new SyncClient(w.transport("otto"), {
    user: "otto",
    clock: slow,
    random: w.random,
    mutators: MUTATORS,
  });
  const id = otto.newId();
  otto.queue("research.createPostFollowUp", { id, thread: p, t: "from a slow clock" });
  const answers: ApplyResult[] = await otto.flush();
  t.deepEqual(
    answers.map((r) => (r.ok ? "ok" : r.error.code)),
    ["ok"],
  );
  const made = [...w.store.records.values()].find(
    (r) => r.kind === "reply" && r.t === "from a slow clock",
  );
  t.not(made && "id" in made ? made.id : id, id, "reminted after CLOCK_SKEW");
  t.true(Math.abs(otto.now() - w.clock.now()) < 1000);
  // EXPIRED: an id more than 4 days old on the device's clock
  const old = otto.newId();
  w.clock.advance(5 * DAY);
  otto.queue("saved.set", { kind: "thread", id: p, on: true }, old);
  const seen = events(otto);
  await otto.flush();
  t.deepEqual(
    otto.problems().map((x) => x.reason),
    ["EXPIRED"],
  );
  t.truthy(seen.find((e) => e.type === "problem"));
  // TOO_LARGE: unrecorded, Not sent
  otto.queue("research.createPostFollowUp", {
    id: otto.newId(),
    thread: p,
    t: "x".repeat(300_000),
  });
  const big = await otto.flush();
  t.is(big[0]?.ok ? "" : big[0]?.error.code, "TOO_LARGE");
  t.is(otto.unsent().length, 1);
});

test("Y5: a client resyncs on a token the server rejects", async (t) => {
  const { w, open } = cast(t);
  const mel = client(w, "mel");
  t.is(await mel.sync(`space:${open}`), "snapshot");
  t.is(await mel.sync(`space:${open}`), "pull");
  w.clock.advance(31 * DAY);
  t.is(await mel.sync(`space:${open}`), "resync");
});

test("R2, R3: pulls drop the content of summary threads; opening one fetches it in full, unless offline", async (t) => {
  const w = new World({ window: { days: 1, threads: 1, cap: 1 } });
  const { open } = cast(t, w);
  const older = post(t, w, "mel", open);
  w.clock.advance(2 * DAY);
  post(t, w, "mel", open);
  const mona = client(w, "mona");
  await mona.sync(`space:${open}`, "window");
  t.false(mona.replica.isFull(`space:${open}`, older));
  // a reply to the summary thread: the counts change arrives, the reply not
  ok(t, w.as("otto", "research.createPostFollowUp", { id: w.id(), thread: older, t: "r" }));
  await mona.sync(`space:${open}`);
  t.like(mona.get(`counts:${older}`), { r: 1 });
  t.false([...mona.records(`space:${open}`).values()].some((r) => r.kind === "reply"));
  // offline: the summary stays, "Couldn't load the rest of this thread."
  const { transport } = flaky(w, "mona");
  const off = new SyncClient(
    { ...transport, snapshot: () => Promise.reject(new Error("offline")) },
    { user: "mona", clock: w.clock, random: w.random, mutators: MUTATORS },
  );
  await off.sync(`space:${open}`, "window").catch(() => undefined);
  t.is(await off.open(older), "missing", "a thread the replica does not hold");
  // online: promoted, kept, and pulls bring its replies from then on
  t.is(await mona.open(older), "full");
  t.true(mona.replica.isFull(`space:${open}`, older));
  t.true([...mona.records(`space:${open}`).values()].some((r) => r.kind === "reply"));
  ok(t, w.as("otto", "research.createPostFollowUp", { id: w.id(), thread: older, t: "r2" }));
  await mona.sync(`space:${open}`);
  t.is([...mona.records(`space:${open}`).values()].filter((r) => r.kind === "reply").length, 2);
  // offline promotion: otto (mel's thread is mel's own, so full for mel)
  const otto = new SyncClient(
    {
      ...w.transport("otto"),
      snapshot: (l, o) =>
        o?.tier === "threads"
          ? Promise.reject(new Error("offline"))
          : w.transport("otto").snapshot(l, o),
    },
    { user: "otto", clock: w.clock, random: w.random, mutators: MUTATORS },
  );
  await otto.sync(`space:${open}`, "window");
  t.is(await otto.open(older), "unavailable");
});

test("R4: a member removed from a private space is told, and its records are dropped", async (t) => {
  const { w, closed } = cast(t);
  const p = post(t, w, "ada", closed);
  const ada = client(w, "ada");
  const seen = events(ada);
  await ada.sync(`space:${closed}`);
  t.truthy(ada.get(`thread:${p}`));
  const m = w.get(`member:${closed}:ada`);
  ok(
    t,
    w.as("olga", "members.remove", {
      space: closed,
      user: "ada",
      base: { adm: m?.kind === "member" ? m.adm : "" },
    }),
  );
  t.is(await ada.sync(`space:${closed}`), "resync");
  t.is(ada.get(`thread:${p}`), undefined);
  t.deepEqual(ada.frozen(`space:${closed}`).size, 0, "the web client keeps no frozen copy");
  t.like(
    seen.find((e) => e.type === "left"),
    { type: "left", name: "lab" },
  );
});

test("Y11: a prediction that reads what the replica cannot know is unknown and has no effect", async (t) => {
  const { w, open, closed } = cast(t);
  const mel = client(w, "mel");
  await mel.sync(`space:${open}`);
  // mel replicates nothing of #lab: a join with a link is predicted only
  // from the space record, which mel does not hold either
  const pending = mel.queue("spaces.join", { space: closed, invite: "x" });
  t.is(mel.prediction(pending.local), "unknown");
  t.is(mel.get(`member:${closed}:mel`), undefined);
  // an ask: the model is checked in the prediction too
  const bad = mel.queue("threads.create", {
    id: w.id(),
    space: open,
    kind: "ask",
    q: "?",
    model: "nope",
    effort: "low",
  });
  t.is(mel.prediction(bad.local), "refused");
  const good = mel.queue("threads.create", {
    id: w.id(),
    space: open,
    kind: "ask",
    q: "?",
    ...MODEL,
  });
  t.is(mel.prediction(good.local), "applied");
});
