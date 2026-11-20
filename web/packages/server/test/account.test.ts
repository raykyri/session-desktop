// The web shell's account routes (phase 2b, in place of tRPC): the account
// and its appearance settings, the runtime configuration, the admin pages'
// reads and writes, sign-out, and the space directory.

import test from "ava";

import { createHarness } from "./helpers.js";
import { HttpClient } from "./sync.helpers.js";

test("/api/me answers the mock's fields and the shell's, and 401 signed out", async (t) => {
  const h = createHarness(t);
  const user = h.addUser("Mel");
  const res = await h.request("/api/me", { cookie: h.signIn(user) });
  t.is(res.status, 200);
  t.like(await res.json(), {
    u: user.handle,
    handle: user.handle,
    login: "Mel",
    id: user.id,
    isAdmin: false,
    bio: "",
  });
  t.is((await h.request("/api/me")).status, 401);
});

test("appearance settings: read, a patch, a bad body, and none for a device token", async (t) => {
  const h = createHarness(t);
  const cookie = h.signIn(h.addUser("olga"));
  const before = (await (await h.request("/api/me/preferences", { cookie })).json()) as {
    appearance: string;
  };
  t.is(typeof before.appearance, "string");
  const saved = await h.post("/api/me/preferences", { settings: { appearance: "light" } }, cookie);
  t.is(saved.status, 200);
  t.is(saved.body["appearance"], "light");
  const again = (await (await h.request("/api/me/preferences", { cookie })).json()) as {
    appearance: string;
  };
  t.is(again.appearance, "light");
  t.is((await h.post("/api/me/preferences", { nope: 1 }, cookie)).status, 400);
  t.is((await h.post("/api/me/preferences", {})).status, 401);
  t.is(
    (await h.request("/api/me/preferences", { headers: { Authorization: "Bearer nope" } })).status,
    401,
  );
});

test("the runtime configuration lists models and limits to anyone", async (t) => {
  const h = createHarness(t);
  const res = await h.request("/api/config");
  t.is(res.status, 200);
  const body = (await res.json()) as { models: unknown[]; limits: { dailyRuns: number } };
  t.true(body.models.length > 0);
  t.is(typeof body.limits.dailyRuns, "number");
});

test("admin routes: an admin lists accounts, sets limits and makes codes; others are refused", async (t) => {
  const h = createHarness(t);
  const admin = h.signIn(h.addUser("root", { isAdmin: true }));
  const plainUser = h.addUser("plain");
  const plain = h.signIn(plainUser);
  const list = await h.request("/api/admin/users", { cookie: admin });
  t.is(list.status, 200);
  const users = (await list.json()) as { login: string; usage: { runs: number } }[];
  t.deepEqual(users.map((u) => u.login).sort(), ["plain", "root"]);
  t.is((await h.request("/api/admin/users", { cookie: plain })).status, 403);
  t.is((await h.request("/api/admin/users")).status, 401);
  const limits = await h.post(
    "/api/admin/limits",
    { userId: plainUser.id, dailyRuns: 3, dailyTokens: null },
    admin,
  );
  t.is(limits.status, 200);
  t.is(limits.body["dailyRuns"], 3);
  t.is((await h.post("/api/admin/limits", { userId: "nobody", dailyRuns: 1 }, admin)).status, 404);
  t.is((await h.post("/api/admin/limits", { userId: plainUser.id }, plain)).status, 403);
  const codes = await h.post("/api/admin/invites", { count: 2 }, admin);
  t.is((codes.body as { codes: string[] }).codes.length, 2);
  t.is((await h.post("/api/admin/invites", { count: 0 }, admin)).status, 400);
  const daily = await h.request("/api/me/usage/daily", { cookie: plain });
  t.is(daily.status, 200);
});

test("/api/spaces lists the spaces the caller may find", async (t) => {
  const h = createHarness(t);
  const olgaUser = h.addUser("olga");
  const olga = h.signIn(olgaUser);
  const client = new HttpClient(h, { cookie: olga });
  const make = async (name: string, extra: Record<string, unknown>) => {
    const r = await client.write("spaces.create", { id: client.id(), name, ...extra });
    t.true(r.body.ok, JSON.stringify(r.body));
  };
  await make("lounge", {});
  await make("attic", { vis: "unlisted", policy: "invite" });
  const anon = (await (await h.request("/api/spaces")).json()) as {
    spaces: { name: string }[];
    stats: unknown[];
  };
  t.deepEqual(
    anon.spaces.map((s) => s.name),
    ["lounge"],
  );
  t.is(anon.stats.length, 1);
  const mine = (await (await h.request("/api/spaces", { cookie: olga })).json()) as {
    spaces: { name: string }[];
  };
  t.deepEqual(
    mine.spaces.map((s) => s.name),
    ["attic", "lounge"],
  );
});
