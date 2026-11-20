// `/api/users` (review round 1 of phase 2, reviewer A's minor notes and
// phase 2a design finding 7): a profile's count of spaces from the
// package's read over the `thread.u` index, without removed threads, and
// at most 100 handles, bounded before any lookup.

import test from "ava";

import { createHarness } from "./helpers.js";
import { HttpClient } from "./sync.helpers.js";

test.serial("/api/users counts the spaces a person wrote in, without a removed thread", async (t) => {
  const h = createHarness(t);
  const olga = new HttpClient(h, { cookie: h.signIn(h.addUser("olga")) });
  const mel = new HttpClient(h, { cookie: h.signIn(h.addUser("mel")) });
  const spaces: string[] = [];
  for (const name of ["lounge", "lab", "den"]) {
    const sp = olga.id();
    await olga.write("spaces.create", { id: sp, name });
    await mel.write("spaces.join", { space: sp });
    spaces.push(sp);
  }
  const post = async (sp: string) => {
    const id = mel.id();
    t.like((await mel.write("threads.create", { id, space: sp, kind: "post", q: "p" })).body, {
      ok: true,
    });
    return id;
  };
  await post(spaces[0] ?? "");
  await post(spaces[0] ?? "");
  await post(spaces[1] ?? "");
  const removed = await post(spaces[2] ?? "");
  const read = async (q: string) =>
    (await (await h.request(`/api/users?${q}`)).json()) as Record<string, { spaces: number }>;
  t.deepEqual(await read("handle=mel&handle=olga&handle=nobody"), {
    mel: { spaces: 3 },
    olga: { spaces: 0 },
  });
  // the moderator removes mel's thread in the third space
  const d = await olga.write("moderation.decide", { item: `p:${removed}`, decision: "removed" });
  t.like(d.body, { ok: true });
  t.deepEqual(await read("handle=mel"), { mel: { spaces: 2 } });
  // at most 100 handles, bounded before any lookup: the 101st is not read
  const others = Array.from({ length: 99 }, (_, k) => `handle=p${k}`).join("&");
  t.deepEqual(await read(`${others}&handle=mel`), { mel: { spaces: 2 } });
  t.deepEqual(await read(`${others}&handle=p99&handle=mel`), {});
});
