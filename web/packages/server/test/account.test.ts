// The web shell's account routes (phase 2b, in place of tRPC): the account
// and its appearance settings, the runtime configuration, the admin pages'
// reads and writes, sign-out, and the space directory.

import { auth } from "@session/db";
import test from "ava";

import { payerFor, tokenSource } from "../src/sync/account.js";

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
  const body = (await res.json()) as { models: unknown[]; limits: Record<string, unknown> };
  t.true(body.models.length > 0);
  t.is(body.limits["includedTokens"], 250_000, "the weekly allowance");
  t.false("dailyRuns" in body.limits, "no daily limits");
});

test("admin routes: an admin lists accounts, sets limits and makes codes; others are refused", async (t) => {
  const h = createHarness(t);
  const admin = h.signIn(h.addUser("root", { isAdmin: true }));
  const plainUser = h.addUser("plain");
  const plain = h.signIn(plainUser);
  const list = await h.request("/api/admin/users", { cookie: admin });
  t.is(list.status, 200);
  const users = (await list.json()) as {
    login: string;
    usage: { runs: number };
    allowance: { defaultTokens: number };
  }[];
  t.deepEqual(users.map((u) => u.login).sort(), ["plain", "root"]);
  t.is((await h.request("/api/admin/users", { cookie: plain })).status, 403);
  t.is((await h.request("/api/admin/users")).status, 401);
  const limits = await h.post(
    "/api/admin/limits",
    { userId: plainUser.id, weeklyTokens: 40_000 },
    admin,
  );
  t.is(limits.status, 200);
  t.like(limits.body, { weeklyTokens: 40_000, defaultTokens: 250_000, used: 0 });
  // the person's own allowance is their usage's cap
  const usage = (await (await h.request("/api/me/usage", { cookie: plain })).json()) as {
    cap: number;
  };
  t.is(usage.cap, 40_000);
  t.like(
    (await h.post("/api/admin/limits", { userId: plainUser.id, weeklyTokens: null }, admin)).body,
    { weeklyTokens: null },
  );
  t.is(
    ((await (await h.request("/api/me/usage", { cookie: plain })).json()) as { cap: number }).cap,
    250_000,
  );
  t.is(
    (await h.post("/api/admin/limits", { userId: plainUser.id, weeklyTokens: -1 }, admin)).status,
    400,
  );
  t.is(
    (await h.post("/api/admin/limits", { userId: "nobody", weeklyTokens: 1 }, admin)).status,
    404,
  );
  t.is(
    (await h.post("/api/admin/limits", { userId: plainUser.id, weeklyTokens: 1 }, plain)).status,
    403,
  );
  const codes = await h.post("/api/admin/invites", { count: 2 }, admin);
  t.is((codes.body as { codes: string[] }).codes.length, 2);
  t.is((await h.post("/api/admin/invites", { count: 0 }, admin)).status, 400);
  t.is(users[0]?.allowance.defaultTokens, 250_000);
  t.is(
    (await h.request("/api/me/usage/daily", { cookie: plain })).status,
    404,
    "no daily usage route",
  );
});

test("a person's own weekly allowance is what the included tokens pay; admins are not exempt", (t) => {
  const h = createHarness(t);
  const root = h.addUser("root", { isAdmin: true });
  const src = () => tokenSource(h.db, h.deps.sync, h.config, root.id, root.handle, "session");
  t.like(src(), { cap: 250_000, left: 250_000 });
  auth.setUserLimits(h.db, root.id, 0);
  t.like(src(), { cap: 0, left: 0 }, "an allowance of 0 pays for nothing, an admin's too");
  const payer = payerFor(h.db, h.deps.sync, h.config, root.id, root.handle, null);
  t.false(payer.ok);
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

test("/api/invites/:code answers an invite link's space and state, signed out too", async (t) => {
  const h = createHarness(t);
  const olga = h.signIn(h.addUser("olga"));
  const client = new HttpClient(h, { cookie: olga });
  const space = client.id();
  const made = await client.write("spaces.create", {
    id: space,
    name: "attic",
    vis: "unlisted",
    policy: "invite",
  });
  t.true(made.body.ok, JSON.stringify(made.body));
  const link = await client.write("invites.create", { id: client.id(), space, days: 7 });
  t.true(link.body.ok, JSON.stringify(link.body));
  const code = (link.body as unknown as { result: { code: string } }).result.code;
  const res = await h.request(`/api/invites/${code}`);
  t.is(res.status, 200);
  const v = (await res.json()) as { space: { name: string }; by: string; state: string };
  t.is(v.space.name, "attic");
  t.is(v.by, "olga");
  t.is(v.state, "live");
  t.is((await h.request("/api/invites/nosuchcode")).status, 404);
  t.is((await h.request("/api/invites/not%20a%20code")).status, 404);
});
