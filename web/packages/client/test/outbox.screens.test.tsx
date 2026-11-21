// "Not sent" in the screens (02 §9.2, W9.2) on the sync replica over the
// sync routes (`syncFake.ts`): a save whose request fails shows the outbox
// toast with Retry and Discard; a reply whose request fails stays in its
// tree with "Not sent · Retry · Discard" under it, and Retry sends it.

import { claimClientId } from "@session/sync/client";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import test from "ava";

import { configureReplica } from "../src/replica/ReplicaProvider.js";
import { HttpSyncTransport } from "../src/replica/http.js";
import type { DraftRef } from "../src/replica/source.js";
import { SyncReplica } from "../src/replica/syncReplica.js";
import { useDraftsStore } from "../src/stores/drafts.js";

import { renderApp, testUser, waitUntil } from "./helpers.js";
import { FakeLocks, FakeStorage, FakeSync } from "./syncFake.js";

const ME = "raymond";

let made: SyncReplica[] = [];
test.afterEach.always(() => {
  cleanup();
  for (const r of made) r.dispose();
  made = [];
  configureReplica(null);
});

function serve() {
  const f = new FakeSync();
  const lounge = f.id();
  f.ok("olga", "spaces.create", { id: lounge, name: "lounge" });
  f.ok(ME, "spaces.join", { space: lounge });
  const post = f.id();
  f.ok("olga", "threads.create", { id: post, space: lounge, kind: "post", q: "Lunch at noon?" });
  const restored: DraftRef[] = [];
  configureReplica({
    create: (viewer) => {
      const r = new SyncReplica({
        me: viewer.kind === "signedOut" ? null : ME,
        writer: viewer.kind === "member",
        userId: viewer.kind === "signedOut" ? null : viewer.user.id,
        transport: new HttpSyncTransport({ fetch: f.fetchFor(ME) }),
        directory: f.directory,
        claim: (userId, register) =>
          claimClientId({
            userId,
            storage: new FakeStorage(),
            locks: new FakeLocks(),
            register,
          }),
        restoreDraft: (d) => {
          restored.push(d);
          useDraftsStore.getState().setDraft(d.key, d.text);
        },
        clock: f.clock,
        maxBackoffMs: 50,
      });
      made.push(r);
      return r;
    },
  });
  useDraftsStore.setState({ byKey: {}, hidden: false });
  return { f, post, restored };
}

const card = (id: string) => document.getElementById(`card-${id}`);
const outboxToast = () => document.querySelector<HTMLElement>("[data-outbox-toast]");

test.serial(
  "a save whose request fails: the toast with Retry and Discard; the save stays until discarded",
  async (t) => {
    const { f, post } = serve();
    await renderApp("/", { user: testUser({ login: ME }) });
    await waitUntil(t, () => card(post) !== null, "the post renders");
    f.offline = true;
    fireEvent.click(within(card(post) as HTMLElement).getByRole("button", { name: /^Save/ }));
    await waitUntil(
      t,
      () => outboxToast()?.textContent?.startsWith("Not sent.") === true,
      "Not sent",
    );
    t.is(outboxToast()?.getAttribute("role"), "alert");
    t.truthy(
      within(card(post) as HTMLElement).getByRole("button", { name: /^Saved/ }),
      "the prediction stays",
    );

    // Discard rolls it back
    fireEvent.click(within(outboxToast() as HTMLElement).getByRole("button", { name: "Discard" }));
    await waitUntil(t, () => outboxToast() === null, "the toast goes");
    t.truthy(within(card(post) as HTMLElement).getByRole("button", { name: /^Save\b/ }));

    // two unsent saves read as one toast; Retry sends both
    fireEvent.click(within(card(post) as HTMLElement).getByRole("button", { name: /^Save/ }));
    await waitUntil(t, () => outboxToast() !== null, "Not sent again");
    fireEvent.click(within(card(post) as HTMLElement).getByRole("button", { name: /^Saved/ }));
    await waitUntil(
      t,
      () => outboxToast()?.textContent?.startsWith("2 changes not sent.") === true,
      "2 changes",
    );
    f.offline = false;
    fireEvent.click(within(outboxToast() as HTMLElement).getByRole("button", { name: "Retry" }));
    await waitUntil(t, () => outboxToast() === null, "both sent");
    t.is(f.get(`save:${ME}:${post}`), undefined, "saved, then removed");
  },
);

test.serial(
  "a reply whose request fails stays in its tree as Not sent; Retry sends it",
  async (t) => {
    const { f, post } = serve();
    await renderApp("/", { user: testUser({ login: ME }) });
    await waitUntil(t, () => card(post) !== null, "the post renders");
    const row = () => card(post)?.closest(".feed-row") as HTMLElement;
    fireEvent.click(within(card(post) as HTMLElement).getByRole("button", { name: "Reply" }));
    const field = await screen.findByRole("textbox", { name: "Reply to @olga" });
    fireEvent.change(field, { target: { value: "See you there" } });
    f.offline = true;
    fireEvent.click(row().querySelector("form.icomp button[type=submit]") as HTMLElement);
    await waitUntil(
      t,
      () => row().querySelector("[data-not-sent]")?.textContent?.includes("Not sent") === true,
      "Not sent under the reply",
    );
    t.true(within(row()).getAllByText("See you there").length > 0, "the reply stays rendered");
    t.is(
      useDraftsStore.getState().byKey[`reply:${post}:top`],
      undefined,
      "the composer is cleared: the reply is the item",
    );

    f.offline = false;
    fireEvent.click(
      within(row().querySelector("[data-not-sent]") as HTMLElement).getByRole("button", {
        name: "Retry",
      }),
    );
    await waitUntil(t, () => row().querySelector("[data-not-sent]") === null, "sent");
    t.true(
      [...f.store.records.values()].some((r) => r.kind === "reply" && r.t === "See you there"),
    );
  },
);
