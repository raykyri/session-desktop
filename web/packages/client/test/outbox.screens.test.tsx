// "Not sent" in the screens (02 §9.2, W9.2) on the sync replica over the
// sync routes (`syncFake.ts`), with the live build's `restoreDraft`: a save
// whose request fails shows the outbox toast with Retry and Discard; a reply
// whose request fails stays in its tree with "Not sent · Retry · Discard"
// under it, and Retry sends it; Discard under a post takes the post away and
// puts its text back in the composer, unless newer text was typed there; a
// Retry the server refuses shows the refusal.

import { claimClientId } from "@session/sync/client";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import test from "ava";

import { clearToast, currentToast } from "../src/features/shell/Toast.js";
import { configureReplica } from "../src/replica/ReplicaProvider.js";
import { HttpSyncTransport } from "../src/replica/http.js";
import { restoreDraft } from "../src/replica/live.js";
import type { DraftRef } from "../src/replica/source.js";
import { SyncReplica } from "../src/replica/syncReplica.js";
import { useDraftsStore } from "../src/stores/drafts.js";
import { composerKey, replyComposerOfKey } from "../src/stores/threadUi.js";

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

function serve(
  o: { refuseApply?: () => boolean; refusal?: { code: string; message: string } } = {},
) {
  const f = new FakeSync();
  const base = f.fetchFor(ME);
  // a refusal of every write while `refuseApply` holds (recorded: FORBIDDEN,
  // unless `refusal` names another)
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (o.refuseApply?.() && url.includes("/apply") && !f.offline)
      return new Response(
        JSON.stringify({
          answers: [
            {
              ok: false,
              error: {
                ...(o.refusal ?? { code: "FORBIDDEN", message: "You can't save in this channel." }),
                serverTime: f.clock.now(),
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    return base(input, init);
  };
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
        transport: new HttpSyncTransport({ fetch }),
        directory: f.directory,
        claim: (userId, register) =>
          claimClientId({
            userId,
            storage: new FakeStorage(),
            locks: new FakeLocks(),
            register,
          }),
        restoreDraft: (d, how) => {
          restored.push(d);
          restoreDraft(d, how);
        },
        clock: f.clock,
        maxBackoffMs: 50,
      });
      made.push(r);
      return r;
    },
  });
  useDraftsStore.setState({ byKey: {}, unsent: {}, hidden: false });
  clearToast();
  return { f, post, lounge, restored };
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

test("a reply's and a comment's draft key name their composer and row; an ask's does not", (t) => {
  const th = "T";
  for (const [composer, selected] of [
    [{ kind: "reply", parent: null }, null],
    [{ kind: "reply", parent: "R" }, "R"],
    [{ kind: "comment", node: "N", parent: null }, "N"],
    [{ kind: "comment", node: "N", parent: "C" }, "N"],
  ] as const)
    t.deepEqual(replyComposerOfKey(composerKey(th, composer)), { thread: th, composer, selected });
  t.is(replyComposerOfKey(composerKey(th, { kind: "ask", parent: "r" })), null);
  t.is(replyComposerOfKey("thread:space"), null);
});

test.serial(
  "Discard on a reply that was not sent opens its composer again with the text, focused",
  async (t) => {
    const { f, post } = serve();
    await renderApp("/", { user: testUser({ login: ME }) });
    await waitUntil(t, () => card(post) !== null, "the post renders");
    const row = () => card(post)?.closest(".feed-row") as HTMLElement;
    fireEvent.click(within(card(post) as HTMLElement).getByRole("button", { name: "Reply" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Reply to @olga" }), {
      target: { value: "See you there" },
    });
    f.offline = true;
    fireEvent.click(row().querySelector("form.icomp button[type=submit]") as HTMLElement);
    await waitUntil(t, () => row().querySelector("[data-not-sent]") !== null, "Not sent");
    t.is(screen.queryByRole("textbox", { name: "Reply to @olga" }), null, "the composer closed");
    fireEvent.click(
      within(row().querySelector("[data-not-sent]") as HTMLElement).getByRole("button", {
        name: "Discard",
      }),
    );
    await waitUntil(t, () => row().querySelector("[data-not-sent]") === null, "discarded");
    const field = await screen.findByRole("textbox", { name: "Reply to @olga" });
    t.is((field as HTMLTextAreaElement).value, "See you there");
    await waitUntil(t, () => document.activeElement === field, "the field has focus");
  },
);

test.serial(
  "a not-sent reply whose card is closed moves to the outbox toast, whose Retry sends it",
  async (t) => {
    const { f, post } = serve();
    await renderApp("/", { user: testUser({ login: ME }) });
    await waitUntil(t, () => card(post) !== null, "the post renders");
    const row = () => card(post)?.closest(".feed-row") as HTMLElement;
    fireEvent.click(within(card(post) as HTMLElement).getByRole("button", { name: "Reply" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Reply to @olga" }), {
      target: { value: "Kept while away" },
    });
    f.offline = true;
    fireEvent.click(row().querySelector("form.icomp button[type=submit]") as HTMLElement);
    await waitUntil(t, () => row().querySelector("[data-not-sent]") !== null, "Not sent");
    t.is(outboxToast(), null, "shown under the reply");
    // deselect the reply: its card, and the line, go
    fireEvent.click(within(row()).getByRole("treeitem", { name: /Kept while away/ }));
    await waitUntil(t, () => row().querySelector("[data-not-sent]") === null, "the card closes");
    await waitUntil(
      t,
      () => outboxToast()?.textContent?.startsWith("Not sent.") === true,
      "the toast",
    );
    f.offline = false;
    fireEvent.click(within(outboxToast() as HTMLElement).getByRole("button", { name: "Retry" }));
    await waitUntil(t, () => outboxToast() === null, "sent");
    t.true(
      [...f.store.records.values()].some((r) => r.kind === "reply" && r.t === "Kept while away"),
    );
  },
);

/** Choose Post in the new-thread composer and type `text`. */
async function writePost(text: string) {
  const field = await screen.findByRole("textbox", { name: "Ask or post" });
  fireEvent.click(screen.getByRole("button", { name: "Ask or post" }));
  fireEvent.click(await screen.findByRole("menuitemradio", { name: /^Post/ }));
  fireEvent.change(field, { target: { value: text } });
  return field as HTMLTextAreaElement;
}

const cardWithText = (text: string) =>
  [...document.querySelectorAll<HTMLElement>("article.tcard")].find((c) =>
    c.textContent?.includes(text),
  ) ?? null;

test.serial(
  "a post whose request fails: Discard under its card takes it away and the composer holds its text",
  async (t) => {
    const { f, post } = serve();
    await renderApp("/", { user: testUser({ login: ME }) });
    await waitUntil(t, () => card(post) !== null, "the feed renders");
    const field = await writePost("Offline thoughts");
    f.offline = true;
    fireEvent.click(screen.getByRole("button", { name: "Post" }));
    await waitUntil(
      t,
      () =>
        cardWithText("Offline thoughts")?.closest(".feed-row")?.querySelector("[data-not-sent]") !=
        null,
      "Not sent under the post",
    );
    t.is(field.value, "", "the composer is cleared: the post is the item");
    const row = cardWithText("Offline thoughts")?.closest(".feed-row") as HTMLElement;
    fireEvent.click(
      within(row.querySelector("[data-not-sent]") as HTMLElement).getByRole("button", {
        name: "Discard",
      }),
    );
    await waitUntil(t, () => cardWithText("Offline thoughts") === null, "the post is gone");
    await waitUntil(t, () => field.value === "Offline thoughts", "the text is back");
  },
);

test.serial("Discard keeps text typed in the composer since", async (t) => {
  const { f, post } = serve();
  await renderApp("/", { user: testUser({ login: ME }) });
  await waitUntil(t, () => card(post) !== null, "the feed renders");
  const field = await writePost("First try");
  f.offline = true;
  fireEvent.click(screen.getByRole("button", { name: "Post" }));
  await waitUntil(
    t,
    () => cardWithText("First try")?.closest(".feed-row")?.querySelector("[data-not-sent]") != null,
    "Not sent",
  );
  fireEvent.change(field, { target: { value: "Something newer" } });
  const row = cardWithText("First try")?.closest(".feed-row") as HTMLElement;
  fireEvent.click(
    within(row.querySelector("[data-not-sent]") as HTMLElement).getByRole("button", {
      name: "Discard",
    }),
  );
  await waitUntil(t, () => cardWithText("First try") === null, "the post is gone");
  t.is(field.value, "Something newer");
});

test.serial("two unsent saves: Discard rolls both back", async (t) => {
  const { f, post, lounge } = serve();
  const second = f.id();
  f.ok("olga", "threads.create", { id: second, space: lounge, kind: "post", q: "Second" });
  await renderApp("/", { user: testUser({ login: ME }) });
  await waitUntil(t, () => card(post) !== null && card(second) !== null, "both render");
  f.offline = true;
  for (const id of [post, second])
    fireEvent.click(within(card(id) as HTMLElement).getByRole("button", { name: /^Save/ }));
  await waitUntil(
    t,
    () => outboxToast()?.textContent?.startsWith("2 changes not sent.") === true,
    "2 changes",
  );
  fireEvent.click(within(outboxToast() as HTMLElement).getByRole("button", { name: "Discard" }));
  await waitUntil(t, () => outboxToast() === null, "the toast goes");
  for (const id of [post, second])
    t.truthy(within(card(id) as HTMLElement).getByRole("button", { name: /^Save\b/ }));
});

test.serial("a Retry the server refuses shows the refusal as an alert", async (t) => {
  let refuse = false;
  const { f, post } = serve({ refuseApply: () => refuse });
  await renderApp("/", { user: testUser({ login: ME }) });
  await waitUntil(t, () => card(post) !== null, "the post renders");
  f.offline = true;
  fireEvent.click(within(card(post) as HTMLElement).getByRole("button", { name: /^Save/ }));
  await waitUntil(t, () => outboxToast() !== null, "Not sent");
  f.offline = false;
  refuse = true;
  fireEvent.click(within(outboxToast() as HTMLElement).getByRole("button", { name: "Retry" }));
  await waitUntil(t, () => currentToast() === "You can't save in this channel.", "the refusal");
  const alert = document.querySelector('[data-toast-region="alert"]');
  t.true(alert?.textContent?.includes("You can't save in this channel.") === true);
  t.truthy(
    within(card(post) as HTMLElement).getByRole("button", { name: /^Save\b/ }),
    "rolled back",
  );
});

test.serial("a write a server limit leaves unsent shows the server's message", async (t) => {
  const message = "You can save 600 threads an hour. Try again in 12 minutes.";
  const { post } = serve({
    refuseApply: () => true,
    refusal: { code: "TOO_MANY_REQUESTS", message },
  });
  await renderApp("/", { user: testUser({ login: ME }) });
  await waitUntil(t, () => card(post) !== null, "the post renders");
  fireEvent.click(within(card(post) as HTMLElement).getByRole("button", { name: /^Save/ }));
  await waitUntil(t, () => outboxToast() !== null, "Not sent");
  t.is(outboxToast()?.querySelector("span")?.textContent, `Not sent. ${message}`);
});

test.serial("an offline save shows no Saved. toast", async (t) => {
  const { f, post } = serve();
  await renderApp("/", { user: testUser({ login: ME }) });
  await waitUntil(t, () => card(post) !== null, "the post renders");
  f.offline = true;
  fireEvent.click(within(card(post) as HTMLElement).getByRole("button", { name: /^Save/ }));
  await waitUntil(t, () => outboxToast() !== null, "Not sent");
  t.not(currentToast(), "Saved.");
  f.offline = false;
  fireEvent.click(within(outboxToast() as HTMLElement).getByRole("button", { name: "Retry" }));
  await waitUntil(t, () => currentToast() === null || outboxToast() === null, "sent");
});

/** Opens an item's "…" menu, chooses `item` and confirms with Delete. */
async function confirmDelete(scope: HTMLElement, item: RegExp | string) {
  fireEvent.click(within(scope).getByRole("button", { name: "More" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: item }));
  const confirm = await screen.findByRole("alertdialog");
  fireEvent.click(within(confirm).getByRole("button", { name: "Delete" }));
}

test.serial("an offline delete of a thread moves focus to the next card at once", async (t) => {
  const { f, post, lounge } = serve();
  const mine = f.id();
  f.ok(ME, "threads.create", { id: mine, space: lounge, kind: "post", q: "Mine to delete" });
  await renderApp("/", { user: testUser({ login: ME }) });
  await waitUntil(t, () => card(post) !== null && card(mine) !== null, "both render");
  f.offline = true;
  await confirmDelete(card(mine) as HTMLElement, /^Delete post/);
  await waitUntil(t, () => card(mine) === null, "the card is gone");
  await waitUntil(t, () => document.activeElement === card(post), "focus on the next card");
  await waitUntil(t, () => outboxToast() !== null, "Not sent");
});

test.serial("an offline delete of a reply moves focus to the next row at once", async (t) => {
  const { f, post } = serve();
  const mine = f.id();
  f.ok(ME, "research.createPostFollowUp", { id: mine, thread: post, t: "Mine to delete" });
  const after = f.id();
  f.ok("olga", "research.createPostFollowUp", { id: after, thread: post, t: "Olga's reply" });
  await renderApp("/", { user: testUser({ login: ME }) });
  await waitUntil(t, () => card(post) !== null, "the post renders");
  const side = () => document.querySelector<HTMLElement>(`[data-side="${post}"]`) as HTMLElement;
  fireEvent.click(within(side()).getByRole("treeitem", { name: /Mine to delete/ }));
  await waitUntil(t, () => side().querySelector(".preview") !== null, "the reply's card");
  f.offline = true;
  await confirmDelete(side().querySelector(".preview") as HTMLElement, "Delete reply");
  await waitUntil(
    t,
    () => within(side()).queryByRole("treeitem", { name: /Mine to delete/ }) === null,
    "the reply is gone",
  );
  await waitUntil(
    t,
    () => document.activeElement === within(side()).queryByRole("treeitem", { name: /Olga's reply/ }),
    "focus on the next row",
  );
});
