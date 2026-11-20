// The per-account budget of writes and online calls (review round 1 of
// phase 2, reviewer A's F6; the experiment e02-limits E2a as a test), and a
// device's calls on a run it holds, which take nothing from it (review round
// 2 of phase 2, reviewer A's finding 2; the experiment e02-budget-device-run).

import test from "ava";

import { createHarness } from "./helpers.js";
import { HttpClient, signInDevice } from "./sync.helpers.js";

class Clock {
  ms = Date.now();
  now = () => this.ms;
}

test.serial(
  "a burst of writes and calls past the budget answers TOO_MANY_REQUESTS with retryAt, unrecorded",
  async (t) => {
    let checks = 0;
    const clock = new Clock();
    const h = createHarness(t, {
      env: { SESSION_WRITE_BURST: "10", SESSION_WRITES_PER_MINUTE: "6" },
      sync: { clock },
      runs: {
        checkKey: () => {
          checks++;
          return Promise.resolve(null);
        },
      },
    });
    const mel = new HttpClient(h, { cookie: h.signIn(h.addUser("mel")) });
    const olga = new HttpClient(h, { cookie: h.signIn(h.addUser("olga")) });
    await mel.register();
    const k = await mel.call("apiKeys.create", { raw: "sk-ant-MEL-KEY-0001", label: "" });
    const id = (k.body.result as { id: string }).id;
    const answers = [];
    for (let n = 0; n < 12; n++) answers.push(await mel.call("apiKeys.check", { id }));
    // one write was the create
    t.deepEqual(
      answers.map((a) => (a.body.ok ? "ok" : a.body.error?.code)),
      [
        ...Array<string>(9).fill("ok"),
        "TOO_MANY_REQUESTS",
        "TOO_MANY_REQUESTS",
        "TOO_MANY_REQUESTS",
      ],
    );
    const refused = answers[9];
    t.is(refused?.status, 429);
    const retryAt = (refused?.body.error as { retryAt?: string } | undefined)?.retryAt;
    const at = Math.ceil((clock.ms + 10_000) / 1000) * 1000;
    t.is(
      retryAt,
      new Date(at).toISOString().replace(".000Z", "Z"),
      "one more in 10 s at 6 a minute",
    );
    for (let n = 0; n < 5; n++) {
      h.deps.sync.work(1000);
      await h.deps.runs.idle();
    }
    t.is(checks, 9, "a refused call queues no provider check");
    // writes draw on the same budget; another person's is their own
    const sp = olga.id();
    const w = await mel.write("spaces.create", { id: sp, name: "lounge" });
    t.like(w.body, { ok: false, error: { code: "TOO_MANY_REQUESTS" } });
    t.is(w.body.seq, undefined, "unrecorded: the seq is not used");
    t.like((await olga.write("spaces.create", { id: sp, name: "lounge" })).body, { ok: true });
    // the bucket refills
    clock.ms += 10_000;
    t.like((await mel.write("spaces.join", { space: sp })).body, { ok: true });
    t.like(
      (await mel.write("threads.create", { id: mel.id(), space: sp, kind: "post", q: "p" })).body,
      {
        ok: false,
        error: { code: "TOO_MANY_REQUESTS" },
      },
    );
    clock.ms += 60_000;
    let ok = 0;
    for (let n = 0; n < 8; n++)
      if (
        (await mel.write("threads.create", { id: mel.id(), space: sp, kind: "post", q: `p${n}` }))
          .body.ok
      )
        ok++;
    t.is(ok, 6, "a minute refilled six");
    // a signed-out caller is counted by address
    const anon = new HttpClient(h, null);
    const here = { "Fly-Client-IP": "203.0.113.5" };
    let signins = 0;
    for (let n = 0; n < 12; n++)
      if ((await anon.call("devices.authorize", { name: "Mac" }, here)).body.ok) signins++;
    t.is(signins, 10);
    t.like(
      (await anon.call("devices.authorize", { name: "Mac" }, { "Fly-Client-IP": "198.51.100.9" }))
        .body,
      {
        ok: true,
      },
    );
  },
);

test.serial(
  "E2: a device's calls on a run it holds take nothing from its person's budget",
  async (t) => {
    const clock = new Clock();
    const h = createHarness(t, {
      env: { SESSION_WRITE_BURST: "120", SESSION_WRITES_PER_MINUTE: "60" },
      sync: { clock },
    });
    const olga = new HttpClient(h, { cookie: h.signIn(h.addUser("olga")) });
    const mel = new HttpClient(h, { cookie: h.signIn(h.addUser("mel")) });
    const sp = olga.id();
    await olga.write("spaces.create", { id: sp, name: "lounge" });
    await mel.write("spaces.join", { space: sp });
    const d = await signInDevice(h, mel);
    const dev = new HttpClient(h, { bearer: d.token });
    const executor = { kind: "device", cli: "claude", device: d.device };
    const th = mel.id();
    const r = await mel.write("threads.create", {
      id: th,
      space: sp,
      kind: "ask",
      q: "Q?",
      executor,
    });
    const run = (r.body.result as { run: string }).run;
    t.like((await dev.call("runs.claim", { run, device: d.device })).body, { ok: true });
    // two turns a second for 200 s, a heartbeat every 30 s
    const refused: string[] = [];
    for (let k = 0; k < 400; k++) {
      clock.ms += 500;
      if (k % 60 === 59) {
        const hb = await dev.call("runs.heartbeat", { run, device: d.device, attempt: 1 });
        if (!hb.body.ok) refused.push(`heartbeat ${k}: ${hb.body.error?.code}`);
      }
      const a = await dev.call("runs.turn", {
        run,
        device: d.device,
        attempt: 1,
        turn: `step ${k}`,
      });
      if (!a.body.ok) refused.push(`turn ${k}: ${a.body.error?.code}`);
    }
    t.deepEqual(refused, []);
    t.like(
      (await dev.call("runs.finish", { run, device: d.device, attempt: 1, answer: "A" })).body,
      { ok: true },
    );
    t.like(h.deps.sync.records().get(`run:${run}`), { status: "complete" });
    // the person's budget is whole: 120 writes at once
    let ok = 0;
    for (let n = 0; n < 121; n++)
      if (
        (await mel.write("threads.create", { id: mel.id(), space: sp, kind: "post", q: `p${n}` }))
          .body.ok
      )
        ok++;
    t.is(ok, 120);
    // a device's call on a run it does not hold is counted: the budget is
    // spent now, so it answers TOO_MANY_REQUESTS before any other check
    t.like((await dev.call("runs.turn", { run, device: d.device, attempt: 1, turn: "x" })).body, {
      ok: false,
      error: { code: "TOO_MANY_REQUESTS" },
    });
    t.like((await dev.call("runs.claim", { run, device: d.device })).body, {
      ok: false,
      error: { code: "TOO_MANY_REQUESTS" },
    });
  },
);
