// The attacks of review round 1 (R1 to R15), each ported as a test that the
// server refuses or filters it. The invariant files hold the general cases;
// these keep each attack's own scenario.

import test from "ava";

import type { ThreadRec } from "../src/index.js";

import { HOUR, actor, cast, ok, refused, thread } from "./harness.js";

test("R1: an approval queued for a request that was approved, then reopened by asking again, is STALE", async (t) => {
  const { w, closed } = await cast(t);
  await ok(
    t,
    w.as("otto", "joinRequests.create", { space: closed, rulesAccepted: true, answers: ["first"] }),
  );
  const mona = w.client("mona");
  mona.queue("joinRequests.decide", {
    space: closed,
    users: ["otto"],
    decision: "approve",
    base: w.requests(closed, ["otto"]),
  });
  await ok(
    t,
    w.as("olga", "joinRequests.decide", {
      space: closed,
      users: ["otto"],
      decision: "approve",
      base: w.requests(closed, ["otto"]),
    }),
  );
  await ok(
    t,
    w.as("olga", "members.remove", { space: closed, user: "otto", base: w.member(closed, "otto") }),
  );
  // otto asks again: the same request record is open again, with a new rev
  const before = w.rev(`request:${closed}:otto`);
  await ok(
    t,
    w.as("otto", "joinRequests.create", {
      space: closed,
      rulesAccepted: true,
      answers: ["second"],
    }),
  );
  t.true(w.rev(`request:${closed}:otto`) > before);
  w.clock.advance(HOUR);
  const [r] = await mona.flush();
  t.is(r?.ok ? "ok" : r?.error.code, "STALE");
  t.is(w.get(`member:${closed}:otto`), undefined);
  // a decline queued from the first request is STALE too
  const olga = w.client("olga");
  olga.queue("joinRequests.decide", {
    space: closed,
    users: ["otto"],
    decision: "decline",
    base: { otto: before },
  });
  const [d] = await olga.flush();
  t.is(d?.ok ? "ok" : d?.error.code, "STALE");
  // a decision on the request as it is now applies
  await ok(
    t,
    w.as("mona", "joinRequests.decide", {
      space: closed,
      users: ["otto"],
      decision: "approve",
      base: w.requests(closed, ["otto"]),
    }),
  );
  t.truthy(w.get(`member:${closed}:otto`));
});

test("R1: reopening a declined request bumps its rev, so a decision made before the reopening is STALE", async (t) => {
  const { w, closed } = await cast(t);
  await ok(t, w.as("otto", "joinRequests.create", { space: closed, rulesAccepted: true }));
  await ok(
    t,
    w.as("olga", "joinRequests.decide", {
      space: closed,
      users: ["otto"],
      decision: "decline",
      base: w.requests(closed, ["otto"]),
    }),
  );
  const declined = w.requests(closed, ["otto"]);
  await ok(
    t,
    w.as("olga", "joinRequests.decide", {
      space: closed,
      users: ["otto"],
      decision: "reopen",
      base: declined,
    }),
  );
  t.true(w.rev(`request:${closed}:otto`) > (declined["otto"] ?? 0));
  await refused(
    t,
    w.as("mona", "joinRequests.decide", {
      space: closed,
      users: ["otto"],
      decision: "reopen",
      base: declined,
    }),
    "STALE",
  );
  // base must name every person decided on, and no one else
  for (const base of [{}, { otto: 1, mel: 1 }, { mel: 1 }])
    await refused(
      t,
      w.as("mona", "joinRequests.decide", {
        space: closed,
        users: ["otto"],
        decision: "approve",
        base,
      }),
      "BAD_REQUEST",
    );
});

test("R1b: a removal queued before a person was removed and let in again is STALE", async (t) => {
  const { w, closed } = await cast(t);
  const mona = w.client("mona");
  mona.queue("members.remove", { space: closed, user: "mel", base: w.member(closed, "mel") });
  mona.queue("members.ban", { space: closed, user: "mel", base: w.member(closed, "mel") });
  const ada = w.client("ada");
  ada.queue("members.setRole", {
    space: closed,
    user: "mel",
    role: "mod",
    base: w.member(closed, "mel"),
  });
  await ok(
    t,
    w.as("olga", "members.remove", { space: closed, user: "mel", base: w.member(closed, "mel") }),
  );
  await ok(t, w.as("mel", "joinRequests.create", { space: closed, rulesAccepted: true }));
  await ok(
    t,
    w.as("olga", "joinRequests.decide", {
      space: closed,
      users: ["mel"],
      decision: "approve",
      base: w.requests(closed, ["mel"]),
    }),
  );
  const results = [...(await mona.flush()), ...(await ada.flush())];
  t.deepEqual(
    results.map((r) => (r.ok ? "ok" : r.error.code)),
    ["STALE", "STALE", "STALE"],
  );
  t.is((w.get(`member:${closed}:mel`) as { role: string } | undefined)?.role, "member");
  t.is(w.get(`ban:${closed}:mel`), undefined);
  // a ban of a person with no member record carries rev 0
  await ok(t, w.as("mona", "members.ban", { space: closed, user: "eve", base: { rev: 0 } }));
  await refused(
    t,
    w.as("mona", "members.ban", { space: closed, user: "otto", base: { rev: 1 } }),
    "STALE",
  );
});

test("R2: a queued 'shown' does not publish text the author changed after the moderator read it", async (t) => {
  const { w, open } = await cast(t);
  const th = await thread(t, w, "otto", open, "post", "borderline v1");
  await ok(
    t,
    w.as("mona", "moderation.decide", {
      item: `p:${th}`,
      decision: "hidden",
      base: w.item(`p:${th}`),
    }),
  );
  const olga = w.client("olga");
  olga.queue("moderation.decide", { item: `p:${th}`, decision: "shown", base: w.item(`p:${th}`) });
  // the author may still edit a hidden thread
  await ok(
    t,
    w.as("otto", "threads.update", { id: th, q: "ABUSE v2", base: { rev: w.rev(`thread:${th}`) } }),
  );
  const [r] = await olga.flush();
  t.is(r?.ok ? "ok" : r?.error.code, "STALE");
  t.is((w.get(`thread:${th}`) as ThreadRec).mod, "hidden");
  const s = await w.server.snapshot(null, `space:${open}`);
  t.false(JSON.stringify(s).includes("ABUSE"));
  const p = s.records.find((x) => x.key === `thread:${th}`)?.record as ThreadRec;
  t.is(p.q, "");
  // the same holds for a queued "removed" or "hidden" after a change of the item
  const mona = w.client("mona");
  mona.queue("moderation.decide", {
    item: `p:${th}`,
    decision: "removed",
    base: { rev: w.rev(`thread:${th}`) - 1 },
  });
  const [x] = await mona.flush();
  t.is(x?.ok ? "ok" : x?.error.code, "STALE");
  t.is(
    JSON.stringify(await w.server.snapshot(actor("otto"), `space:${open}`)).includes("ABUSE"),
    true,
  );
});
