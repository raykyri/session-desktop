// The Desktop app's platform (phase 3): the sign-in kept in the Keychain,
// the replica per person in SQLite through the bridge, and what a sign-out
// and a refused token clear.

import { SqliteStorage } from "@session/sync/client";
import test from "ava";

import { Desktop, replicaFile } from "../src/platform.js";

import { FakeBridge } from "./fakeBridge.js";

const signIn = { token: "tok-1", device: "01DEVICE0000000000000000AA", u: "ines.v" };

test("no Keychain item, or one that is not the app's: the sign-in shows", async (t) => {
  const b = new FakeBridge();
  const d = await Desktop.start(b);
  t.is(d.state(), "signin");
  t.is(d.token(), null);
  b.keychain = "{not json";
  t.is((await Desktop.start(b)).state(), "signin");
  b.keychain = JSON.stringify({ token: 1 });
  t.is((await Desktop.start(b)).state(), "signin");
});

test("a sign-in is kept in the Keychain, and the app starts signed in from it", async (t) => {
  const b = new FakeBridge();
  b.origin = "https://session.test/";
  const d = await Desktop.start(b);
  t.is(d.origin, "https://session.test");
  let changes = 0;
  d.onChange(() => changes++);
  await d.signedIn(signIn);
  t.is(changes, 1);
  t.is(d.state(), "app");
  t.is(d.token(), "tok-1");
  t.is(d.handle(), "ines.v");
  t.deepEqual(JSON.parse(b.keychain ?? ""), {
    token: "tok-1",
    device: signIn.device,
    handle: "ines.v",
    me: null,
  });
  // requests: the bearer token, no cookie, no CSRF header
  t.deepEqual(d.headers(), {});
  t.is(d.credentials, "omit");
  t.true(d.persist);
  t.is(d.here, "this Mac");
  const again = await Desktop.start(b);
  t.is(again.state(), "app");
  t.is(again.token(), "tok-1");
});

test("the account as last read is kept for a start offline", async (t) => {
  const b = new FakeBridge();
  const d = await Desktop.start(b);
  t.is(d.lastMe(), null);
  await d.signedIn(signIn);
  d.rememberMe({ u: "ines.v", name: "Ines" }, "tok-1");
  await new Promise((r) => setTimeout(r, 0));
  t.deepEqual((await Desktop.start(b)).lastMe(), { u: "ines.v", name: "Ines" });
  // null (signed out) does not replace it; the platform's unauthorized does
  d.rememberMe(null, "tok-1");
  t.deepEqual(d.lastMe(), { u: "ines.v", name: "Ines" });
});

test("each person's replica is a SQLite file that outlives the app", async (t) => {
  const b = new FakeBridge();
  const d = await Desktop.start(b);
  await d.signedIn(signIn);
  const s = d.storage("ines.v");
  t.true(s instanceof SqliteStorage);
  t.is(d.storage("ines.v"), s);
  await s.saveMeta({ user: "ines.v", clientId: "c1", lastSeq: 3, offset: 0 });
  await s.saveOutbox([{ local: "w1" }]);
  t.true(b.hasReplica("ines.v"));
  const after = await Desktop.start(b);
  const s2 = after.storage("ines.v");
  t.like(await s2.loadMeta(), { user: "ines.v", clientId: "c1", lastSeq: 3 });
  t.deepEqual(await s2.loadOutbox(), [{ local: "w1" }]);
  t.is(replicaFile("Ines.V"), "replica-ines.v.sqlite");
  t.is(replicaFile("a/b c"), "replica-a_b_c.sqlite");
});

test("a token the server no longer takes: the replica, the outbox and the Keychain item go", async (t) => {
  const b = new FakeBridge();
  const d = await Desktop.start(b);
  await d.signedIn(signIn);
  const s = d.storage("ines.v");
  await s.saveMeta({ user: "ines.v", clientId: "c1", lastSeq: 0, offset: 0 });
  await s.saveOutbox([{ local: "w1" }]);
  const states: string[] = [];
  d.onChange(() => states.push(d.state()));
  d.unauthorized("tok-1");
  t.is(d.token(), null);
  await new Promise((r) => setTimeout(r, 10));
  t.deepEqual(states, ["signin"]);
  t.is(b.keychain, null);
  // the replica's file is deleted
  t.deepEqual(b.deleted, ["ines.v"]);
  t.false(b.hasReplica("ines.v"));
  t.is(await d.storage("ines.v").loadMeta(), null);
  t.deepEqual(await d.storage("ines.v").loadOutbox(), []);
  // signed out already: nothing more
  d.unauthorized("tok-1");
  t.deepEqual(states, ["signin"]);
});

test("sign-out revokes this device's token on the server, then clears the device", async (t) => {
  const b = new FakeBridge();
  const d = await Desktop.start(b);
  await d.signedIn(signIn);
  await d.storage("ines.v").saveOutbox([{ local: "w1" }]);
  const calls: { url: string; init: RequestInit }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    calls.push({ url: url instanceof Request ? url.url : url.toString(), init: init ?? {} });
    return Promise.resolve(new Response(JSON.stringify({ ok: true, result: null })));
  };
  try {
    await d.signOut();
  } finally {
    globalThis.fetch = real;
  }
  t.is(calls.length, 1);
  t.is(calls[0]?.url, "https://session.test/api/rpc/devices.revoke");
  t.like(calls[0]?.init.headers, { Authorization: "Bearer tok-1" });
  t.deepEqual(JSON.parse(calls[0]?.init.body as string), { id: signIn.device });
  t.is(d.state(), "signin");
  t.is(b.keychain, null);
  t.deepEqual(await d.storage("ines.v").loadOutbox(), []);
});

test("sign-out without a connection still clears the device", async (t) => {
  const b = new FakeBridge();
  const d = await Desktop.start(b);
  await d.signedIn(signIn);
  const real = globalThis.fetch;
  globalThis.fetch = () => Promise.reject(new TypeError("offline"));
  try {
    await d.signOut();
  } finally {
    globalThis.fetch = real;
  }
  t.is(d.state(), "signin");
  t.is(b.keychain, null);
});

test("links open in the system browser; the window's title follows the page's", async (t) => {
  const b = new FakeBridge();
  const d = await Desktop.start(b);
  await d.openExternal("/device?request=r1");
  await d.openExternal("https://example.com/x");
  await new Promise((r) => setTimeout(r, 0));
  t.deepEqual(b.opened, ["https://session.test/device?request=r1", "https://example.com/x"]);
  d.update();
  await new Promise((r) => setTimeout(r, 0));
  t.is(b.opened.at(-1), "https://session.test/download");
  const doc = { title: "Session — Home", querySelector: () => null } as unknown as Document;
  d.followTitle(doc);
  t.is(b.title, "Session — Home");
});
