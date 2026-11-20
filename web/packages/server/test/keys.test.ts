// API key checks (review round 1 of phase 2, reviewer A's F8): a verdict
// applies only to the raw key it checked.

import test from "ava";

import { createHarness } from "./helpers.js";
import { HttpClient } from "./sync.helpers.js";

test.serial("a key replaced while its check runs keeps its own check's verdict", async (t) => {
  const pending: { raw: string; done: (reason: string | null) => void }[] = [];
  const h = createHarness(t, {
    runs: {
      checkKey: (_provider, raw) =>
        new Promise((done) => {
          pending.push({ raw, done });
        }),
    },
  });
  const mel = new HttpClient(h, { cookie: h.signIn(h.addUser("mel")) });
  const k = await mel.call("apiKeys.create", {
    raw: "sk-or-OLD-KEY-0001",
    label: "",
    check: true,
  });
  const id = (k.body.result as { id: string }).id;
  h.deps.sync.work();
  t.is(pending.length, 1, "the old key's check runs");
  t.like((await mel.call("apiKeys.replace", { id, raw: "sk-or-NEW-KEY-0002" })).body, {
    ok: true,
  });
  // the old key's verdict lands after the replace: it is dropped
  pending[0]?.done("the provider rejected it");
  await h.deps.runs.idle();
  t.like(h.deps.sync.records().get(`apikey:${id}`), { status: "checking" });
  h.deps.sync.work();
  t.is(pending[1]?.raw, "sk-or-NEW-KEY-0002");
  pending[1]?.done(null);
  await h.deps.runs.idle();
  t.like(h.deps.sync.records().get(`apikey:${id}`), { status: "valid" });
  const keys = (await (
    await h.request("/api/me/api-keys", { cookie: (mel.auth as { cookie: string }).cookie })
  ).json()) as { id: string; reason?: string | null }[];
  t.falsy(keys.find((x) => x.id === id)?.reason);
});
