// The feed's write guards and viewer states on the fixture replica (02
// §12.1): one send per click while a write is in flight, an unloaded index
// shown as loading rather than missing, the queue-full refusal, the thread
// UI reset per account, the offline New channel dialog, the owner's and the
// author's "…" menus, hidden threads, the private save count, signed-out
// reply, and that a write to one thread re-renders no other row.

import { QUEUED_RUNS_MAX, type StoredRecord } from "@session/mutators";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import test from "ava";
import { Profiler } from "react";

import { useNewChannelDialog } from "../src/features/channels/NewChannelDialog.js";
import { ThreadRow } from "../src/features/feed/ThreadRow.js";
import { currentToast } from "../src/features/shell/Toast.js";
import { ReplicaProvider, configureReplica } from "../src/replica/ReplicaProvider.js";
import {
  createFixtureReplica,
  fixtureReplicaConfig,
  runControl,
  type FixtureReplica,
} from "../src/replica/fixtureReplica.js";
import { channelByName } from "../src/replica/queries.js";
import type { WriteOutcome } from "../src/replica/source.js";
import { QUEUE_FULL_MESSAGE, makeWrites } from "../src/replica/writes.js";
import { useDraftsStore } from "../src/stores/drafts.js";
import { claimLocalAccountState, clearLocalAccountState } from "../src/stores/localAccount.js";
import { useThreadUiStore } from "../src/stores/threadUi.js";

import { renderApp, renderInRouter, testUser, waitUntil } from "./helpers.js";

const FIRST = "01M7HWGZJGT7JTFFVSYPX055KV";
const SECOND = "01M7HQMDT0RH0G2WHVJHQ6Z8C2";
/** @ines.v's post in #ml, with replies by @lettie and @jun.park. */
const SEED_POST = "01M7GNRKE0SEEDP0ST00000000";
const REPLY_POST_TEXT = "Is anyone else seeing the follow-up count lag";

let made: FixtureReplica[] = [];
/** Runs on each replica the app creates, before the app reads it. */
let prepare: (replica: FixtureReplica) => void = () => {};

test.beforeEach(() => {
  made = [];
  prepare = () => {};
  configureReplica({
    ...fixtureReplicaConfig({ runMs: null }),
    create: (viewer) => {
      const replica = fixtureReplicaConfig({ runMs: null }).create(viewer) as FixtureReplica;
      prepare(replica);
      made.push(replica);
      return replica;
    },
  });
  useDraftsStore.setState({ byKey: {}, hidden: false });
  useThreadUiStore.getState().reset();
});
test.afterEach.always(() => {
  cleanup();
  for (const r of made) r.dispose();
  configureReplica(null);
  runControl.hold = null;
  useNewChannelDialog.setState({ open: false });
  Object.defineProperty(navigator, "onLine", { configurable: true, get: () => true });
});

const replicaOf = () => {
  const replica = made[made.length - 1];
  if (!replica) throw new Error("no replica");
  return replica;
};

/** Makes `mutate` wait for `release()`, counting the calls by name. */
function gateMutations(replica: FixtureReplica) {
  const calls: string[] = [];
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const mutate = replica.mutate.bind(replica);
  replica.mutate = async (name, input) => {
    calls.push(name);
    await gate;
    return mutate(name, input);
  };
  return { calls, release: () => release() };
}

const cardOf = (id: string) => document.getElementById(`card-${id}`);

/** A thread of the fixtures by another member, in the channel `name`. */
function othersThread(replica: FixtureReplica, name: string, k: "ask" | "post" = "post") {
  const space = channelByName(replica, name);
  const thread = replica
    .rawAll("thread")
    .find((r) => r.s === space?.id && r.u !== "ines.v" && r.k === k && r.mod === null && !r.del);
  if (!thread) throw new Error(`no thread by another member in #${name}`);
  return thread;
}

const rewrite = (replica: FixtureReplica, record: StoredRecord, change: Record<string, unknown>) =>
  replica.write([{ ...record, ...change }]);

async function openMore(card: HTMLElement) {
  fireEvent.click(within(card).getByRole("button", { name: "More" }));
  return screen.findByRole("menu");
}

test.serial("one send per click while the write is in flight; later text is kept", async (t) => {
  await renderApp("/");
  const field = await screen.findByRole("textbox", { name: "Ask or post" });
  fireEvent.click(screen.getByRole("button", { name: "Ask or post" }));
  fireEvent.click(await screen.findByRole("menuitemradio", { name: /^Post/ }));
  const { calls, release } = gateMutations(replicaOf());
  fireEvent.change(field, { target: { value: "One post only." } });
  const form = field.closest("form");
  t.true(form?.classList.contains("nb"));
  t.true(form?.classList.contains("has-text"));

  fireEvent.click(screen.getByRole("button", { name: "Post" }));
  fireEvent.keyDown(field, { key: "Enter", ctrlKey: true });
  fireEvent.click(screen.getByRole("button", { name: "Post" }));
  t.deepEqual(calls, ["threads.create"]);
  // Typed while the first send is in flight: kept when it lands.
  fireEvent.change(field, { target: { value: "Typed meanwhile." } });
  release();
  await waitUntil(
    t,
    () =>
      document.querySelectorAll(".tt-title").length > 0 &&
      screen.queryAllByText("One post only.").length === 1,
    "the post lands once",
  );
  t.is((field as HTMLTextAreaElement).value, "Typed meanwhile.");
  t.deepEqual(calls, ["threads.create"]);
});

test.serial("an unloaded thread is a loading row, not a missing one", async (t) => {
  const replica = createFixtureReplica("ines.v", { runMs: null });
  replica.unload({ th: FIRST });
  await renderInRouter(
    <ReplicaProvider viewer={{ kind: "member", user: testUser(), isAdmin: false }} source={replica}>
      <ThreadRow id={FIRST} now={replica.now()} />
    </ReplicaProvider>,
  );
  t.truthy(document.querySelector('[aria-label="Loading"][aria-busy="true"]'));
  t.is(cardOf(FIRST), null);
  replica.load({ th: FIRST });
  await waitUntil(t, () => cardOf(FIRST) !== null, "the thread renders once loaded");
  replica.dispose();
});

test.serial("a thread address waits for an unloaded thread instead of a toast", async (t) => {
  prepare = (replica) => replica.unload({ th: FIRST });
  await renderApp(`/?t=${FIRST}`);
  await waitUntil(t, () => document.querySelector(".tcard") !== null, "the feed renders");
  t.is(cardOf(FIRST), null);
  t.not(currentToast(), "This thread is not available.");
  replicaOf().load({ th: FIRST });
  await waitUntil(t, () => cardOf(FIRST) !== null, "the thread renders once loaded");
  t.not(currentToast(), "This thread is not available.");
});

test.serial("a run is refused before it is sent while the queue is full", async (t) => {
  const replica = createFixtureReplica("ines.v", { runMs: null });
  const writes = makeWrites(replica);
  const space = channelByName(replica, "sci-fi");
  if (!space) throw new Error("no sci-fi");
  runControl.hold = "queued";
  for (let i = 0; i < QUEUED_RUNS_MAX; i++)
    t.truthy(await writes.ask(space.id, `queued ${i}`, "gemini-flash", "low"));
  let sent = 0;
  const mutate = replica.mutate.bind(replica);
  replica.mutate = (name, input) => {
    sent++;
    return mutate(name, input);
  };
  t.is(await writes.ask(space.id, "one too many", "gemini-flash", "low"), null);
  t.is(sent, 0);
  t.is(currentToast(), QUEUE_FULL_MESSAGE);
  replica.dispose();
});

test.serial("the server's queue_full refusal shows the same toast", async (t) => {
  const replica = createFixtureReplica("ines.v", { runMs: null });
  replica.mutate = () =>
    Promise.resolve({
      ok: false,
      error: { reason: "queue_full", message: "queue full" },
    } as unknown as WriteOutcome);
  const space = channelByName(replica, "sci-fi");
  if (!space) throw new Error("no sci-fi");
  t.is(await makeWrites(replica).ask(space.id, "q", "gemini-flash", "low"), null);
  t.is(currentToast(), QUEUE_FULL_MESSAGE);
  replica.dispose();
});

test.serial("thread selections and composers are cleared per account", (t) => {
  const ui = useThreadUiStore.getState();
  claimLocalAccountState("a");
  ui.open(FIRST, { kind: "ask", parent: "r" } as never, "r");
  claimLocalAccountState("a");
  t.truthy(useThreadUiStore.getState().byThread[FIRST]);
  claimLocalAccountState("b");
  t.deepEqual(useThreadUiStore.getState().byThread, {});
  useThreadUiStore.getState().select(FIRST, "r");
  clearLocalAccountState();
  t.deepEqual(useThreadUiStore.getState().byThread, {});
});

test.serial("without an invite a selected branch has no composer actions", async (t) => {
  await renderApp("/", { user: { ...testUser({ login: "new.one" }), status: "waiting" } as never });
  const side = await waitForSide(t);
  fireEvent.click(within(side).getByRole("treeitem", { name: /how does the darknet/ }));
  await within(side).findByText(/Tasks are posted to the darknet/);
  t.is(within(side).queryByRole("button", { name: "Continue" }), null);
  t.is(within(side).queryByRole("button", { name: "Comment" }), null);
  t.is(within(side).queryByRole("button", { name: "Branch" }), null);
});

async function waitForSide(t: Parameters<typeof waitUntil>[0]) {
  await waitUntil(
    t,
    () => document.querySelector(`[data-side="${FIRST}"]`) !== null,
    "the side column renders",
  );
  return document.querySelector<HTMLElement>(`[data-side="${FIRST}"]`) as HTMLElement;
}

test.serial("New channel offline says it needs a connection and cannot submit", async (t) => {
  await renderApp("/");
  Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false });
  window.dispatchEvent(new Event("offline"));
  fireEvent.click(await screen.findByRole("button", { name: "New channel" }));
  const dialog = await screen.findByRole("dialog", { name: "New channel" });
  t.truthy(within(dialog).getByRole("status"));
  t.regex(within(dialog).getByRole("status").textContent ?? "", /needs a connection/);
  t.true(within(dialog).getByRole("button", { name: "Create channel" }).hasAttribute("disabled"));
});

test.serial("Delete is disabled on one's post once others have replied", async (t) => {
  await renderApp("/");
  await waitUntil(t, () => cardOf(SEED_POST) !== null, "the post renders");
  await openMore(cardOf(SEED_POST) as HTMLElement);
  const item = await screen.findByRole("menuitem", { name: /Delete post/ });
  t.is(item.getAttribute("aria-disabled"), "true");
  t.regex(item.textContent ?? "", /Not available once someone else has responded/);
});

test.serial("the owner's menu: Remove… opens the dialog once per click; Ban", async (t) => {
  let thread: StoredRecord | null = null;
  prepare = (replica) => (thread = othersThread(replica, "sci-fi"));
  await renderApp("/c/sci-fi");
  const id = (thread as unknown as { id: string } | null)?.id ?? "";
  await waitUntil(t, () => cardOf(id) !== null, "the thread renders");
  const menu = await openMore(cardOf(id) as HTMLElement);
  t.truthy(within(menu).getByRole("menuitem", { name: "Ban from #sci-fi" }));
  t.is(within(menu).queryByRole("menuitem", { name: /^Delete/ }), null);
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Remove…" }));
  const dialog = await screen.findByRole("dialog", { name: /^Remove @/ });
  const { calls, release } = gateMutations(replicaOf());
  const remove = within(dialog).getByRole("button", { name: "Remove" });
  fireEvent.click(remove);
  fireEvent.click(remove);
  t.deepEqual(calls, ["moderation.decide"]);
  t.true((remove as HTMLButtonElement).disabled);
  release();
  await waitUntil(t, () => currentToast() === "Removed.", "the Removed toast");
  t.deepEqual(calls, ["moderation.decide"]);
});

test.serial(
  "Remove…: a reason over 300 characters is announced and focus goes back to the field",
  async (t) => {
    let thread: StoredRecord | null = null;
    prepare = (replica) => (thread = othersThread(replica, "sci-fi"));
    await renderApp("/c/sci-fi");
    const id = (thread as unknown as { id: string } | null)?.id ?? "";
    await waitUntil(t, () => cardOf(id) !== null, "the thread renders");
    const menu = await openMore(cardOf(id) as HTMLElement);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Remove…" }));
    const dialog = await screen.findByRole("dialog", { name: /^Remove @/ });
    const field = within(dialog).getByRole("textbox", { name: /Reason/ });
    fireEvent.change(field, { target: { value: "x".repeat(301) } });
    const { calls } = gateMutations(replicaOf());
    const remove = within(dialog).getByRole("button", { name: "Remove" });
    remove.focus();
    fireEvent.click(remove);
    const alert = await within(dialog).findByRole("alert");
    t.is(alert.textContent, "Keep the reason under 300 characters.");
    t.is(document.activeElement, field);
    t.is(field.getAttribute("aria-invalid"), "true");
    t.is(field.getAttribute("aria-describedby"), alert.id);
    t.deepEqual(calls, []);
  },
);

test.serial("the owner's own thread has no Remove… and no Ban (04 O4)", async (t) => {
  let id = "";
  prepare = (replica) => {
    const found = othersThread(replica, "sci-fi");
    id = found.id;
    rewrite(replica, found, { u: "ines.v" });
  };
  await renderApp("/c/sci-fi");
  await waitUntil(t, () => cardOf(id) !== null, "the thread renders");
  const menu = await openMore(cardOf(id) as HTMLElement);
  t.truthy(within(menu).getByRole("menuitem", { name: /^Delete post/ }));
  t.is(within(menu).queryByRole("menuitem", { name: "Remove…" }), null);
  t.is(within(menu).queryByRole("menuitem", { name: "Ban from #sci-fi" }), null);
});

test.serial("a member's menu on another person's thread has no Remove… and no Ban", async (t) => {
  let id = "";
  prepare = (replica) => {
    id = othersThread(replica, "public").id;
  };
  // the "…" button shows only when the menu has an item
  await renderApp("/c/public");
  await waitUntil(t, () => cardOf(id) !== null, "the thread renders");
  const more = within(cardOf(id) as HTMLElement).queryByRole("button", { name: "More" });
  if (more) {
    fireEvent.click(more);
    const menu = await screen.findByRole("menu");
    t.is(within(menu).queryByRole("menuitem", { name: "Remove…" }), null);
    t.is(within(menu).queryByRole("menuitem", { name: /^Ban from/ }), null);
  } else {
    t.is(screen.queryByRole("menuitem", { name: "Remove…" }), null);
    t.is(screen.queryByRole("menuitem", { name: /^Ban from/ }), null);
  }
});

test.serial("a hidden thread shows its owner the note above its text", async (t) => {
  let thread: StoredRecord | null = null;
  prepare = (replica) => {
    const found = othersThread(replica, "sci-fi");
    thread = found;
    rewrite(replica, found, { mod: "hidden", modBy: "ines.v" });
  };
  await renderApp("/c/sci-fi");
  const id = (thread as unknown as { id: string } | null)?.id ?? "";
  await waitUntil(t, () => cardOf(id) !== null, "the thread renders");
  const card = cardOf(id) as HTMLElement;
  const note = card.querySelector(".hiddenln");
  t.is(note?.textContent, "Hidden by the channel owner");
  const title = card.querySelector(".tt-title");
  t.truthy(title?.textContent);
  // The note comes before the title row.
  t.true(
    Boolean(
      note && title && note.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING,
    ),
  );
});

test.serial("a private channel shows no save count below 3", async (t) => {
  let id = "";
  prepare = (replica) => {
    const space = channelByName(replica, "grant-review");
    const thread = replica.rawAll("thread").find((r) => r.s === space?.id && r.mod === null);
    if (!thread) throw new Error("no private thread");
    id = thread.id;
    const counts = replica.rawAll("counts").find((c) => c.th === thread.id);
    if (!counts) throw new Error("no counts");
    rewrite(replica, counts, { saves: 2 });
  };
  await renderApp("/c/grant-review");
  await waitUntil(t, () => cardOf(id) !== null, "the thread renders");
  const card = within(cardOf(id) as HTMLElement);
  t.truthy(card.getByRole("button", { name: /^Save/ }));
  t.is(card.getByRole("button", { name: /^Save/ }).getAttribute("aria-label"), "Save");
  const counts = replicaOf()
    .rawAll("counts")
    .find((c) => c.th === id);
  if (counts) rewrite(replicaOf(), counts, { saves: 3 });
  await waitUntil(
    t,
    () => card.queryByRole("button", { name: "Save, saved by 3" }) !== null,
    "three saves are counted",
  );
});

test.serial("signed out, Sign in to reply opens sign-in", async (t) => {
  await renderApp("/", { user: null });
  await waitUntil(
    t,
    () => screen.queryAllByText(new RegExp(REPLY_POST_TEXT)).length > 0,
    "the post renders",
  );
  const row = screen.getAllByText(new RegExp(REPLY_POST_TEXT))[0]?.closest(".feed-row");
  if (!(row instanceof HTMLElement)) throw new Error("no row");
  fireEvent.click(within(row).getByRole("button", { name: "Sign in to reply" }));
  await waitUntil(
    t,
    () => screen.queryByRole("dialog", { name: "Sign in to Session" }) !== null,
    "the sign-in dialog opens",
  );
});

test.serial("a write to one thread re-renders that row only (W9.1)", async (t) => {
  const replica = createFixtureReplica("ines.v", { runMs: null });
  const commits: Record<string, number> = { [FIRST]: 0, [SECOND]: 0 };
  const onRender = (id: string) => {
    commits[id] = (commits[id] ?? 0) + 1;
  };
  await renderInRouter(
    <ReplicaProvider viewer={{ kind: "member", user: testUser(), isAdmin: false }} source={replica}>
      {[FIRST, SECOND].map((id) => (
        <Profiler key={id} id={id} onRender={onRender}>
          <ThreadRow id={id} now={replica.now()} />
        </Profiler>
      ))}
    </ReplicaProvider>,
  );
  await waitUntil(t, () => cardOf(FIRST) !== null && cardOf(SECOND) !== null, "both rows render");
  const before = { ...commits };
  await makeWrites(replica).save(FIRST, true);
  await waitUntil(
    t,
    () => (commits[FIRST] ?? 0) > (before[FIRST] ?? 0),
    "the saved thread's row re-renders",
  );
  t.is(commits[SECOND], before[SECOND]);
  replica.dispose();
});
