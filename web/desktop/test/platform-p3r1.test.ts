// Review round 1 of phase 3 (reviewer A), the Desktop platform: answers
// bound to the sign-in that asked (finding 1, the reviewer's two
// experiments), the replica's file deleted at sign-out (finding 5), two
// copies of the app on one replica (finding 4), the storage problem with
// Try again and Reset (finding 7), and the token kept before the app says
// it is signed in (finding 10).

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FetchTransport, SyncClient, type OutboxEntry } from "@session/sync/client";
import test from "ava";

import { ReplicaError } from "../src/bridge.js";
import { Desktop, replicaFile } from "../src/platform.js";
import { keepToken } from "../src/signin.js";

import { FakeBridge } from "./fakeBridge.js";

const tempDir = (t: { teardown(f: () => void): void }) => {
  const dir = mkdtempSync(join(tmpdir(), "session-p3r1-"));
  t.teardown(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const offlineFetch = async (f: () => Promise<void>) => {
  const real = globalThis.fetch;
  globalThis.fetch = () => Promise.reject(new TypeError("offline"));
  try {
    await f();
  } finally {
    globalThis.fetch = real;
  }
};

test("finding 1: a late /api/me answer of A's changes nothing of B's: neither B's account nor B's sign-in", async (t) => {
  const b = new FakeBridge();
  const d = await Desktop.start(b);
  await d.signedIn({ token: "tok-ana", device: "dev-a", u: "ana" });
  await offlineFetch(() => d.signOut());
  await d.signedIn({ token: "tok-bo", device: "dev-b", u: "bo" });
  await d.storage("bo").saveMeta({ user: "bo", clientId: "c", lastSeq: 0, offset: 0 });
  await d.storage("bo").saveOutbox([{ local: "bo-w1" }]);

  // 1. A's /api/me answers 200 late, read with A's token
  d.rememberMe({ handle: "ana", u: "ana", name: "Ana" }, "tok-ana");
  await new Promise((r) => setTimeout(r, 0));
  const item = JSON.parse(b.keychain ?? "null") as { handle: string; me: unknown };
  t.is(item.handle, "bo");
  t.is(item.me, null);
  t.is(d.lastMe(), null);
  // B's own account is kept; an account of another person is not, even
  // with B's token
  d.rememberMe({ handle: "ana", u: "ana" }, "tok-bo");
  t.is(d.lastMe(), null);
  d.rememberMe({ handle: "bo", u: "bo", name: "Bo" }, "tok-bo");
  t.like(d.lastMe(), { handle: "bo" });

  // 2. A's /api/me answers 401 late (A's token was revoked)
  d.unauthorized("tok-ana");
  await new Promise((r) => setTimeout(r, 10));
  t.is(d.state(), "app");
  t.is(d.handle(), "bo");
  t.deepEqual(await d.storage("bo").loadOutbox(), [{ local: "bo-w1" }]);
  t.not(b.keychain, null);
  // B's own 401 signs B out
  d.unauthorized("tok-bo");
  t.is(d.state(), "signin");
});

/** A server for one test, as `fetch`: device tokens of two people,
 * registration, writes (WRONG_CLIENT for a client id of someone else's),
 * and `devices.revoke`. The first write's answer is held until `release`. */
function server() {
  const people = new Map([
    ["tok-ana", "ana"],
    ["tok-bo", "bo"],
  ]);
  const clients = new Map<string, string>();
  const applied: { u: string; name: string; input: unknown }[] = [];
  const log: string[] = [];
  let release: (() => void) | null = null;
  let writes = 0;
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const auth = new Headers(init?.headers).get("Authorization") ?? "";
    const token = auth.replace(/^Bearer /, "");
    const u = people.get(token);
    const path = new URL(url).pathname;
    log.push(`${path} ${token || "(none)"}`);
    const serverTime = Date.now();
    if (path === "/api/rpc/devices.revoke") {
      people.delete(token);
      return json(200, { ok: true, result: null, serverTime });
    }
    if (!u)
      return json(401, { ok: false, error: { code: "UNAUTHORIZED", message: "" }, serverTime });
    if (path === "/api/sync/register") {
      const id = `client-${clients.size + 1}`;
      clients.set(id, u);
      return json(200, { ok: true, clientId: id, serverTime, u });
    }
    if (path === "/api/sync/write") {
      const e = JSON.parse(init?.body as string) as {
        clientId: string;
        seq: number;
        name: string;
        input: unknown;
      };
      if (clients.get(e.clientId) !== u)
        return json(401, { ok: false, error: { code: "WRONG_CLIENT", message: "" }, serverTime });
      applied.push({ u, name: e.name, input: e.input });
      const answer = json(200, { ok: true, result: null, serverTime, seq: e.seq });
      if (writes++ === 0) await new Promise<void>((r) => (release = r));
      return answer;
    }
    return json(404, { ok: false, error: { code: "NOT_FOUND", message: "" }, serverTime });
  };
  return {
    fetch,
    applied,
    log,
    release: () => release?.(),
    held: () => release !== null,
  };
}

test("finding 1 (the reviewer's sign-out experiment): A's write answered after A signed out and B signed in is never sent as B's, and A's replica is not written again", async (t) => {
  const dir = tempDir(t);
  const b = new FakeBridge(dir);
  b.origin = "https://session.test";
  const s = server();
  const d = await Desktop.start(b);
  await d.signedIn({ token: "tok-ana", device: "dev-a", u: "ana" });
  // the session's client, its token read as the platform has it now (no
  // binding: the client's stop and the storage's close alone hold)
  const client = new SyncClient({
    user: "ana",
    transport: new FetchTransport({
      baseUrl: d.origin,
      token: () => d.token(),
      fetch: s.fetch,
    }),
    persist: true,
    storage: d.storage("ana"),
  });
  await client.init();
  client.write("profile.update", { name: "Ana one", bio: "" });
  client.write("profile.update", { name: "Ana's second write", bio: "" });
  for (let k = 0; k < 100 && !s.held(); k++) await new Promise((r) => setTimeout(r, 5));
  t.true(s.held(), "the first write is on the wire");

  // A signs out (the screens close: the session stops its client)
  const real = globalThis.fetch;
  globalThis.fetch = s.fetch;
  try {
    const out = d.signOut();
    client.stop();
    await out;
  } finally {
    globalThis.fetch = real;
  }
  t.deepEqual(b.deleted, ["ana"]);
  t.false(readdirSync(dir).some((f) => f.startsWith(replicaFile("ana"))));

  // B signs in on the same Mac; A's late answer arrives
  await d.signedIn({ token: "tok-bo", device: "dev-b", u: "bo" });
  s.release();
  await new Promise((r) => setTimeout(r, 100));

  t.deepEqual(
    s.applied.map((a) => [a.u, (a.input as { name: string }).name]),
    [["ana", "Ana one"]],
  );
  t.false(
    s.log.some((l) => l.endsWith("tok-bo")),
    JSON.stringify(s.log),
  );
  // A's replica was not made again
  t.false(readdirSync(dir).some((f) => f.startsWith(replicaFile("ana"))));
  t.false(b.hasReplica("ana"));
});

test("finding 5 (the reviewer's experiment): after sign-out no file on the Mac holds the person's text", async (t) => {
  const dir = tempDir(t);
  const b = new FakeBridge(dir);
  const d = await Desktop.start(b);
  await d.signedIn({ token: "tok", device: "dev", u: "ines.v" });
  const s = d.storage("ines.v");
  const secret = "PRIVATE-DRAFT: the merger closes on Friday";
  await s.saveMeta({ user: "ines.v", clientId: "c1", lastSeq: 0, offset: 0 });
  await s.saveLog("space:01M2JF0CG0R6DSGAXNG6C1ZTM5", {
    cursor: "c",
    puts: [["reply:1", { kind: "reply", t: secret } as never]],
    dels: [],
  });
  await s.saveOutbox([{ local: "w1", input: { t: secret } }]);
  t.true(readdirSync(dir).includes(replicaFile("ines.v")));
  await offlineFetch(() => d.signOut());
  t.deepEqual(readdirSync(dir), []);
  const copies = readdirSync(dir)
    .map((f) => readFileSync(join(dir, f)).toString("latin1"))
    .join("")
    .split(secret).length;
  t.is(copies - 1, 0);
  // a write that arrives after the sign-out is refused, and makes no file
  await t.throwsAsync(s.saveOutbox([{ local: "late" }]));
  t.deepEqual(readdirSync(dir), []);
});

test("finding 4 (the reviewer's experiment): a second copy of the app on the same replica is refused; the first's writes stay", async (t) => {
  const dir = tempDir(t);
  const offline = new FetchTransport({
    baseUrl: "https://session.test",
    token: () => "tok",
    fetch: () => Promise.reject(new TypeError("offline")),
  });
  const copy = async () => {
    const b = new FakeBridge(dir);
    b.keychain = JSON.stringify({ token: "tok", device: "dev", handle: "ines.v", me: null });
    const d = await Desktop.start(b);
    const c = new SyncClient({
      user: "ines.v",
      transport: offline,
      persist: true,
      storage: d.storage("ines.v"),
      timer: null,
    });
    return { b, d, c };
  };
  const first = await copy();
  await first.c.init();
  first.c.write(
    "profile.update",
    { name: "written in the first window", bio: "" },
    { send: false },
  );
  await new Promise((r) => setTimeout(r, 20));

  const second = await copy();
  const e = await t.throwsAsync(second.c.init());
  t.is((e as ReplicaError).code, "LOCKED");
  // the session hands the failure to the platform: the storage problem
  second.d.storageFailed("ines.v", e);
  t.is(second.d.state(), "storage");
  t.like(second.d.problem(), { code: "LOCKED" });
  // another copy's file is never read or reset from here
  t.is(await second.d.unsentWrites(), null);
  await second.d.resetReplica();
  t.deepEqual(second.b.deleted, []);

  // the first quits; Try again opens the file, with the first's write
  first.c.stop();
  first.b.quit();
  second.d.retryStorage();
  t.is(second.d.state(), "app");
  const again = new SyncClient({
    user: "ines.v",
    transport: offline,
    persist: true,
    storage: second.d.storage("ines.v"),
    timer: null,
  });
  await again.init();
  t.deepEqual(
    again.outbox().map((w) => (w.input as { name: string }).name),
    ["written in the first window"],
  );
  second.b.quit();
});

test("finding 7: a replica SQLite fails to open shows the storage problem; Try again opens it, and Reset deletes it after its unsent writes are listed", async (t) => {
  const dir = tempDir(t);
  const b = new FakeBridge(dir);
  b.keychain = JSON.stringify({ token: "tok", device: "dev", handle: "ines.v", me: null });
  // an earlier run of the app left a write in the outbox
  const first = await Desktop.start(b);
  const s0 = first.storage("ines.v");
  await s0.saveMeta({ user: "ines.v", clientId: "c1", lastSeq: 0, offset: 0 });
  const entry: Partial<OutboxEntry> = {
    local: "w1",
    name: "research.createPostFollowUp",
    input: { thread: "01M769ZZR0AGZ2PQESX65WRGQS", q: "the text to keep" },
    state: "queued",
    mutationId: "01M7E164R0AAAAAAAAAAAAAAAA",
  };
  await s0.saveOutbox([entry, { ...entry, local: "w2", state: "answered" }]);
  first.retryStorage(); // no problem: nothing happens
  t.is(first.state(), "app");
  b.quit();

  // the app starts again, and the replica fails to open
  const d = await Desktop.start(b);
  b.failOpen.push(new ReplicaError("FAILED", "file is not a database"));
  const c = new SyncClient({
    user: "ines.v",
    transport: new FetchTransport({ baseUrl: "", fetch: () => Promise.reject(new TypeError()) }),
    persist: true,
    storage: d.storage("ines.v"),
    timer: null,
  });
  const states: string[] = [];
  d.onChange(() => states.push(d.state()));
  const e = await t.throwsAsync(c.init());
  d.storageFailed("ines.v", e);
  t.deepEqual(states, ["storage"]);
  t.like(d.problem(), { handle: "ines.v", code: "FAILED", message: "file is not a database" });
  // another person's failure changes nothing
  d.storageFailed("bo", e);
  t.deepEqual(states, ["storage"]);

  // the unsent writes that can be read (the file opens this time)
  t.deepEqual(
    (await d.unsentWrites())?.map((w) => w.local),
    ["w1"],
  );
  // Try again: a new storage, which opens
  d.retryStorage();
  t.is(d.state(), "app");
  t.like(await d.storage("ines.v").loadMeta(), { clientId: "c1" });
  // it fails again, and Reset deletes the file
  d.storageFailed("ines.v", new ReplicaError("FAILED", "disk I/O error"));
  await d.resetReplica();
  t.deepEqual(b.deleted, ["ines.v"]);
  t.false(readdirSync(dir).includes(replicaFile("ines.v")));
  t.is(d.state(), "app");
  t.deepEqual(await d.storage("ines.v").loadOutbox(), []);
  b.quit();
});

test("finding 10: the token is stored before the app is signed in; a token the Keychain refused is revoked with itself", async (t) => {
  const b = new FakeBridge();
  const d = await Desktop.start(b);
  const revoked: string[] = [];
  const desktop = {
    signedIn: (x: { token: string; device: string; u: string }) => d.signedIn(x),
    revoke: (x: { token: string; device: string }) => {
      revoked.push(`${x.token} ${x.device}`);
      return Promise.resolve();
    },
  };
  b.keychainFails = true;
  const r = await keepToken(desktop, { token: "tok-1", device: "dev-1", u: "ines.v" });
  t.deepEqual(r, { ok: false, message: "The Keychain refused the item." });
  t.deepEqual(revoked, ["tok-1 dev-1"]);
  t.is(d.state(), "signin");
  t.is(d.token(), null);
  b.keychainFails = false;
  t.deepEqual(await keepToken(desktop, { token: "tok-2", device: "dev-2", u: "ines.v" }), {
    ok: true,
  });
  t.deepEqual(revoked, ["tok-1 dev-1"]);
  t.is(d.state(), "app");
  t.like(JSON.parse(b.keychain ?? "{}"), { token: "tok-2" });
});

test("finding 2: links the app opens are http, https or mailto, else the server's", async (t) => {
  const b = new FakeBridge();
  const d = await Desktop.start(b);
  d.openExternal("mailto:a@b.c");
  d.openExternal("/s/x");
  b.openFails = true;
  // a link that cannot be opened is no unhandled rejection
  d.openExternal("https://example.com/");
  await new Promise((r) => setTimeout(r, 0));
  t.deepEqual(b.opened, ["mailto:a@b.c", "https://session.test/s/x"]);
});

test("finding 1: an answer read with an earlier sign-in's token is not kept, even for the same person", async (t) => {
  const b = new FakeBridge();
  const d = await Desktop.start(b);
  await d.signedIn({ token: "tok-1", device: "dev-1", u: "ines.v" });
  await offlineFetch(() => d.signOut());
  await d.signedIn({ token: "tok-2", device: "dev-2", u: "ines.v" });
  d.rememberMe({ handle: "ines.v", u: "ines.v", name: "Old" }, "tok-1");
  t.is(d.lastMe(), null);
  d.rememberMe({ handle: "ines.v", u: "ines.v", name: "New" }, "tok-2");
  t.like(d.lastMe(), { name: "New" });
});

test("finding 1: a write the session asks for after its token was refused is not stored: the storage closes before the screens do", async (t) => {
  const dir = tempDir(t);
  const b = new FakeBridge(dir);
  const d = await Desktop.start(b);
  await d.signedIn({ token: "tok", device: "dev", u: "ines.v" });
  const s = d.storage("ines.v");
  await s.saveMeta({ user: "ines.v", clientId: "c1", lastSeq: 0, offset: 0 });
  d.unauthorized("tok");
  // the session is still up for a moment: its next write is refused
  await t.throwsAsync(s.saveOutbox([{ local: "late" }]));
  await new Promise((r) => setTimeout(r, 20));
  t.deepEqual(readdirSync(dir), []);
});

test("finding 7: a replica that failed to open opens on the storage's next call", async (t) => {
  const b = new FakeBridge();
  const d = await Desktop.start(b);
  await d.signedIn({ token: "tok", device: "dev", u: "ines.v" });
  b.failOpen.push(new ReplicaError("FAILED", "database is locked"));
  const s = d.storage("ines.v");
  await t.throwsAsync(s.loadMeta(), { message: "database is locked" });
  t.is(await s.loadMeta(), null);
  t.true(b.hasReplica("ines.v"));
});
