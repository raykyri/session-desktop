// Review round 1 of phase 3 (reviewer A), the client's side of the
// platform: a session's requests carry its own sign-in's token and no
// other (finding 1); `/api/me`'s answers name the token they were asked
// with (finding 1); a replica that cannot be opened is the platform's
// storage problem, not a lost connection (finding 7); and the desktop
// session's watch of its own requests (finding 8).

import { MemoryStorage } from "@session/sync/client";
import test from "ava";

import { meResource } from "../src/api/account.js";
import { setFetch } from "../src/api/http.js";
import { setPlatform, webPlatform, type Platform } from "../src/platform.js";
import { SpacesSession } from "../src/sync/session.js";

import { createFetchStub } from "./fetchStub.js";
import { waitUntil } from "./helpers.js";

test.afterEach.always(() => {
  setPlatform(null);
  setFetch(null);
  meResource.reset();
});

/** A desktop platform whose sign-in the test changes, recording what the
 * client tells it. */
function desktop() {
  const said: string[] = [];
  const p = {
    ...webPlatform,
    kind: "desktop" as const,
    origin: "",
    persist: true,
    here: "this Mac",
    credentials: "omit" as const,
    headers: () => ({}),
    current: "tok-ana" as string | null,
    token(): string | null {
      return p.current;
    },
    rememberMe: (me: unknown, token: string | null) =>
      void said.push(`rememberMe ${(me as { handle?: string } | null)?.handle ?? null} ${token}`),
    unauthorized: (token: string | null) => void said.push(`unauthorized ${token}`),
    storageFailed: (user: string, e: unknown) =>
      void said.push(`storageFailed ${user} ${e instanceof Error ? e.message : String(e)}`),
  };
  setPlatform(p satisfies Platform);
  return { p, said };
}

const bearer = (h: Headers) => h.get("Authorization") ?? "(none)";

test.serial(
  "finding 1: a session's requests carry its own sign-in's token, and none once another sign-in holds the device",
  async (t) => {
    const { p } = desktop();
    const stub = createFetchStub();
    const s = new SpacesSession("ana", {
      fetch: stub.fetch,
      listen: false,
      storage: new MemoryStorage(),
    });
    await s.start();
    await waitUntil(t, () => stub.calls.some((c) => c.path === "/api/sync/snapshot"), "read");
    t.true(
      stub.calls
        .filter((c) => c.path.startsWith("/api/sync/"))
        .every((c) => bearer(c.headers) === "Bearer tok-ana"),
    );
    // bo signs in on the device while ana's session is still up
    p.current = "tok-bo";
    const n = stub.calls.length;
    await s.retry();
    s.client?.write("profile.update", { name: "Ana", bio: "" });
    await waitUntil(t, () => stub.calls.length > n + 1, "more requests");
    const later = stub.calls.slice(n).filter((c) => c.path.startsWith("/api/sync/"));
    t.true(later.length > 0);
    t.deepEqual(
      [...new Set(later.map((c) => bearer(c.headers)))],
      ["(none)"],
      "no request of ana's session carries bo's token",
    );
    s.stop();
  },
);

test.serial(
  "finding 1: /api/me's answers name the token the request was made with, not the one signed in when they arrive",
  async (t) => {
    const { p, said } = desktop();
    let answer: ((r: Response) => void) | null = null;
    setFetch(() => new Promise<Response>((r) => (answer = r)));
    const loading = meResource.load(true).catch(() => null);
    await waitUntil(t, () => answer !== null, "asked");
    p.current = "tok-bo";
    (answer as unknown as (r: Response) => void)(
      new Response(JSON.stringify({ handle: "ana", u: "ana" }), { status: 200 }),
    );
    await loading;
    t.deepEqual(said, ["rememberMe ana tok-ana"]);
    // a 401
    answer = null;
    p.current = "tok-ana";
    const again = meResource.load(true).catch(() => null);
    await waitUntil(t, () => answer !== null, "asked again");
    p.current = "tok-bo";
    (answer as unknown as (r: Response) => void)(
      new Response(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "" } }), {
        status: 401,
      }),
    );
    await again;
    t.deepEqual(said.slice(1), ["rememberMe null tok-ana", "unauthorized tok-ana"]);
  },
);

test.serial(
  "finding 7: a replica that cannot be opened is the platform's storage problem; the session does not read as offline",
  async (t) => {
    const { said } = desktop();
    const stub = createFetchStub();
    const broken = new MemoryStorage();
    broken.loadMeta = () => Promise.reject(new Error("database is locked"));
    const s = new SpacesSession("ana", { fetch: stub.fetch, listen: false, storage: broken });
    await s.start();
    t.deepEqual(said, ["storageFailed ana database is locked"]);
    t.like(s.status(), { ready: true, online: true });
    // nothing is read for a replica that is not there
    t.false(stub.calls.some((c) => c.path.startsWith("/api/sync/")));
    s.stop();
  },
);

test.serial(
  "finding 8: a desktop session's request that gets no response shows offline; the first response after it ends that and reads again",
  async (t) => {
    desktop();
    const stub = createFetchStub();
    let down = false;
    const fetch: typeof globalThis.fetch = (input, init) =>
      down ? Promise.reject(new TypeError("Failed to fetch")) : stub.fetch(input, init);
    const s = new SpacesSession("ana", { fetch, listen: false, storage: new MemoryStorage() });
    await s.start();
    await waitUntil(t, () => stub.calls.some((c) => c.path === "/api/sync/snapshot"), "read");
    t.true(s.status().online);
    // the server cannot be reached (the browser still says online)
    down = true;
    await s.client?.sync().catch(() => false);
    t.false(s.status().online);
    down = false;
    // the server answers again: the next request's response ends offline,
    // and the session reads again (its logs, then the outbox)
    const n = stub.calls.length;
    s.client?.write("profile.update", { name: "Ana", bio: "" });
    await waitUntil(t, () => s.status().online, "online again");
    await waitUntil(
      t,
      () =>
        stub.calls
          .slice(n)
          .some((c) => c.path === "/api/sync/pull" || c.path === "/api/sync/snapshot"),
      "read again",
    );
    s.stop();
  },
);

test.serial("finding 8: the web's session does not watch its requests", async (t) => {
  setPlatform(null);
  const stub = createFetchStub();
  let down = false;
  const fetch: typeof globalThis.fetch = (input, init) =>
    down ? Promise.reject(new TypeError("Failed to fetch")) : stub.fetch(input, init);
  const s = new SpacesSession("ana", { fetch, listen: false });
  await s.start();
  t.true(s.status().online);
  down = true;
  await s.client?.sync().catch(() => false);
  t.true(s.status().online);
  s.stop();
});
