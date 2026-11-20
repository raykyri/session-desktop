// The per-account budget of writes and online calls (review round 1 of
// phase 2, reviewer A's F6; the experiment e02-limits E2a as a test).

import test from "ava";

import { createHarness } from "./helpers.js";
import { HttpClient } from "./sync.helpers.js";

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
