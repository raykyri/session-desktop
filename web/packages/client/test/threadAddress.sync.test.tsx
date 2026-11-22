// A thread that no longer exists, opened on the sync replica over the sync
// routes (`syncFake.ts`). A thread its author deleted before anyone replied
// is kept as a `gone` record that lists leave out: its address and its
// notification say "This thread is not available." (02 §2.1, W2.6). A
// thread its channel's owner removed keeps its placeholder in the feed, and
// its address shows that.

import { claimClientId } from "@session/sync/client";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import test from "ava";

import { THREAD_UNAVAILABLE } from "../src/features/feed/reveal.js";
import { clearToast, currentToast } from "../src/features/shell/Toast.js";
import { configureReplica } from "../src/replica/ReplicaProvider.js";
import { HttpSyncTransport } from "../src/replica/http.js";
import { SyncReplica } from "../src/replica/syncReplica.js";

import { renderApp, testUser, waitUntil } from "./helpers.js";
import { FakeLocks, FakeStorage, FakeSync } from "./syncFake.js";

const ME = "raymond";

let made: SyncReplica[] = [];
test.afterEach.always(() => {
  cleanup();
  for (const r of made) r.dispose();
  made = [];
  configureReplica(null);
  clearToast();
});

/** #lounge, olga's, which the viewer joined, with one post of olga's that
 * stays. */
function serve() {
  const f = new FakeSync();
  const fetch = f.fetchFor(ME);
  const lounge = f.id();
  f.ok("olga", "spaces.create", { id: lounge, name: "lounge" });
  f.ok(ME, "spaces.join", { space: lounge });
  const kept = f.id();
  f.ok("olga", "threads.create", { id: kept, space: lounge, kind: "post", q: "Lunch at noon?" });
  configureReplica({
    create: (viewer) => {
      const r = new SyncReplica({
        me: viewer.kind === "signedOut" ? null : ME,
        writer: viewer.kind === "member",
        userId: viewer.kind === "signedOut" ? null : viewer.user.id,
        transport: new HttpSyncTransport({ fetch }),
        directory: f.directory,
        claim: (userId, register) =>
          claimClientId({
            userId,
            storage: new FakeStorage(),
            locks: new FakeLocks(),
            register,
          }),
        clock: f.clock,
        maxBackoffMs: 50,
      });
      made.push(r);
      return r;
    },
  });
  clearToast();
  return { f, lounge, kept };
}

const card = (id: string) => document.getElementById(`card-${id}`);

test.serial("the address of a thread deleted before anyone replied says so", async (t) => {
  const { f, lounge, kept } = serve();
  const gone = f.id();
  f.ok("olga", "threads.create", { id: gone, space: lounge, kind: "post", q: "Never mind" });
  f.ok("olga", "threads.delete", { id: gone });
  await renderApp(`/c/lounge?t=${gone}`, { user: testUser({ login: ME }) });
  await waitUntil(t, () => card(kept) !== null, "the feed renders");
  await waitUntil(t, () => currentToast() === THREAD_UNAVAILABLE, "the toast");
  t.is(card(gone), null);
});

test.serial("the address of a thread the owner removed shows its placeholder", async (t) => {
  const { f, lounge, kept } = serve();
  const removed = f.id();
  f.ok(ME, "threads.create", { id: removed, space: lounge, kind: "post", q: "Off topic" });
  f.ok("olga", "moderation.decide", { item: `p:${removed}`, decision: "removed", note: "" });
  await renderApp(`/c/lounge?t=${removed}`, { user: testUser({ login: ME }) });
  await waitUntil(t, () => card(kept) !== null, "the feed renders");
  await waitUntil(
    t,
    () => card(removed)?.textContent?.includes("Removed by @olga") === true,
    "the placeholder",
  );
  t.not(currentToast(), THREAD_UNAVAILABLE);
});

test.serial(
  "a notification of a thread deleted before anyone replied says so and stays",
  async (t) => {
    const { f, lounge } = serve();
    const gone = f.id();
    f.ok("olga", "threads.create", {
      id: gone,
      space: lounge,
      kind: "post",
      q: `@${ME} have a look`,
    });
    f.ok("olga", "threads.delete", { id: gone });
    const app = await renderApp("/notifications", { user: testUser({ login: ME }) });
    const row = await screen.findByText(/a deleted thread/);
    fireEvent.click(row.closest(".nrow") as HTMLElement);
    await waitUntil(t, () => currentToast() === THREAD_UNAVAILABLE, "the toast");
    t.is(app.router.state.location.pathname, "/notifications");
  },
);
