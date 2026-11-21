// The feed screens on the fixture replica (02 §12.1): the viewer states of
// the card's footer and the composer, the empty states, the channel header
// per relation, the About editor stacked over the info dialog, the layout
// preference, and that a write to one thread re-renders no other.

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import test from "ava";
import { useRef } from "react";

import { currentToast } from "../src/features/shell/Toast.js";
import {
  ReplicaProvider,
  configureReplica,
  useReplicaQuery,
} from "../src/replica/ReplicaProvider.js";
import {
  createFixtureReplica,
  fixtureReplicaConfig,
  type FixtureReplica,
} from "../src/replica/fixtureReplica.js";
import { threadOf } from "../src/replica/queries.js";
import { makeWrites } from "../src/replica/writes.js";
import { useDraftsStore } from "../src/stores/drafts.js";
import { useNavigationStore } from "../src/stores/navigation.js";

import { renderApp, testUser, waitUntil } from "./helpers.js";

const FIRST = "01M7HWGZJGT7JTFFVSYPX055KV";
const waiting = () => ({ ...testUser({ login: "new.one" }), status: "waiting" }) as never;

let made: FixtureReplica[] = [];
test.beforeEach(() => {
  made = [];
  configureReplica({
    ...fixtureReplicaConfig({ runMs: null }),
    create: (viewer) => {
      const replica = fixtureReplicaConfig({ runMs: null }).create(viewer) as FixtureReplica;
      made.push(replica);
      return replica;
    },
  });
  useDraftsStore.setState({ byKey: {}, hidden: false });
});
test.afterEach.always(() => {
  cleanup();
  for (const r of made) r.dispose();
  configureReplica(null);
});

const firstCard = () => document.getElementById(`card-${FIRST}`) as HTMLElement;

test.serial("a member's footer: counts, the follow-up and Save with its toasts", async (t) => {
  await renderApp("/");
  await waitUntil(t, () => firstCard() !== null, "the first thread renders");
  const card = within(firstCard());
  const save = card.getByRole("button", { name: "Save, saved by 26" });
  t.is(save.getAttribute("aria-pressed"), "false");
  t.truthy(card.getByRole("button", { name: "Ask a follow-up, 6 branches" }));
  fireEvent.click(save);
  await waitUntil(t, () => currentToast() === "Saved.", "the Saved toast");
  await waitUntil(
    t,
    () => card.queryByRole("button", { name: "Saved, saved by 27" }) !== null,
    "the count goes up",
  );
  fireEvent.click(card.getByRole("button", { name: "Saved, saved by 27" }));
  await waitUntil(t, () => currentToast() === "Removed from saved.", "the unsave toast");
});

test.serial("without an invite: the banner, no composer, disabled write controls", async (t) => {
  await renderApp("/", { user: waiting() });
  await waitUntil(t, () => document.querySelector(".tcard") !== null, "threads render");
  t.truthy(screen.getByText(/You don.t have an invite yet\./));
  t.is(screen.queryByRole("textbox", { name: "Ask or post" }), null);
  const first = document.querySelector<HTMLElement>(".tcard");
  if (!first) throw new Error("no card");
  const save = within(first).getByRole("button", { name: /^Save/ });
  t.true((save as HTMLButtonElement).disabled);
  t.is(save.getAttribute("title"), "Saving opens once you have an invite");
});

test.serial("signed out: the composer is a cover that opens sign-in", async (t) => {
  const result = await renderApp("/", { user: null });
  await waitUntil(t, () => document.querySelector(".tcard") !== null, "threads render");
  const cover = screen.getByRole("button", { name: "Sign in to ask or post" });
  fireEvent.click(cover);
  await waitUntil(t, () => result.router.state.location.pathname === "/login", "sign-in opens");
});

test.serial(
  "the composer: mode, placeholder, the model picker only for asks, the empty state",
  async (t) => {
    await renderApp("/");
    const field = await screen.findByRole("textbox", { name: "Ask or post" });
    t.is(field.getAttribute("placeholder"), "Ask anything");
    const send = screen.getByRole("button", { name: "Ask" });
    t.true((send as HTMLButtonElement).disabled);
    t.truthy(screen.getByTitle("Model and effort"));
    t.truthy(screen.getByTitle("Channel"));
    // The member's avatar at the start.
    t.is(document.querySelector(".nb .nb-av")?.textContent, "IV");
    fireEvent.click(screen.getByRole("button", { name: "Ask or post" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /^Post/ }));
    await waitUntil(t, () => field.getAttribute("placeholder") === "Write a post", "post mode");
    t.is(screen.queryByTitle("Model and effort"), null);
    fireEvent.change(field, { target: { value: "hello" } });
    t.false(screen.getByRole("button", { name: "Post" }).hasAttribute("disabled"));
    t.is(useDraftsStore.getState().byKey["new"]?.text, "hello");
  },
);

test.serial("empty states: Saved, and a channel without threads", async (t) => {
  await renderApp("/saved");
  t.truthy(await screen.findByRole("heading", { name: "Nothing saved yet" }));
  t.truthy(screen.getByRole("link", { name: "Go to Home" }));
  const replica = made[made.length - 1];
  if (!replica) throw new Error("no replica");
  const created = await makeWrites(replica).createChannel({
    name: "empty-one",
    desc: "",
    vis: "open",
  });
  t.true(created.ok);
  fireEvent.click(await screen.findByRole("link", { name: "#empty-one" }));
  t.truthy(await screen.findByText("No threads here yet. Ask the first question."));
});

test.serial("the channel header per relation", async (t) => {
  await renderApp("/c/sci-fi");
  t.truthy(await screen.findByText("Your channel"));
  cleanup();
  await renderApp("/c/public");
  await screen.findByText("#public", { selector: ".sphead h2" });
  const header = document.querySelector<HTMLElement>(".sphead");
  if (!header) throw new Error("no header");
  t.truthy(within(header).getByRole("button", { name: "Joined" }));
  cleanup();
  await renderApp("/c/history");
  t.truthy(await screen.findByRole("button", { name: "Join" }));
  t.is(screen.queryByRole("textbox", { name: "Ask or post" }), null);
  cleanup();
  await renderApp("/c/northwind-eng");
  t.truthy(await screen.findByText("Members only"));
  t.truthy(screen.getByText("This channel is private. Ask @hal_b to add you."));
});

test.serial("the About editor opens over the info dialog; a non-owner has no Edit", async (t) => {
  await renderApp("/c/sci-fi");
  fireEvent.click(await screen.findByRole("button", { name: "About this channel" }));
  const info = await screen.findByRole("dialog", { name: "#sci-fi" });
  fireEvent.click(within(info).getByRole("button", { name: "Edit" }));
  const editor = await screen.findByRole("dialog", { name: "Edit #sci-fi" });
  const about = within(editor).getByRole("textbox");
  fireEvent.change(about, { target: { value: "New about." } });
  t.truthy(within(editor).getByText("10 / 300"));
  fireEvent.click(within(editor).getByRole("button", { name: "Save" }));
  await waitUntil(t, () => currentToast() === "Channel updated.", "the toast");
  await waitUntil(
    t,
    () => screen.queryByRole("dialog", { name: "Edit #sci-fi" }) === null,
    "the editor closes",
  );
  t.truthy(screen.getByRole("dialog", { name: "#sci-fi" }));
  cleanup();
  await renderApp("/c/public");
  fireEvent.click(await screen.findByRole("button", { name: "About this channel" }));
  const other = await screen.findByRole("dialog", { name: "#public" });
  t.is(within(other).queryByRole("button", { name: "Edit" }), null);
});

test.serial(
  "the layout toggle writes prefs.set, and a prefs change from the replica applies",
  async (t) => {
    useNavigationStore.setState({ layout: "centred" });
    await renderApp("/");
    const replica = made[made.length - 1];
    if (!replica) throw new Error("no replica");
    fireEvent.click(await screen.findByRole("button", { name: "Expand" }));
    await waitUntil(
      t,
      () => (replica.raw("prefs:ines.v") as { layout?: string } | undefined)?.layout === "wide",
      "prefs written",
    );
    t.is(useNavigationStore.getState().layout, "wide");
    // Another tab or device of the account changes it back.
    replica.write([{ kind: "prefs", u: "ines.v", layout: "centred" }]);
    await waitUntil(t, () => useNavigationStore.getState().layout === "centred", "applied");
  },
);

test.serial("a write to one thread does not re-render another thread's query", async (t) => {
  const replica = createFixtureReplica("ines.v", { runMs: null });
  const renders: Record<string, number> = {};
  function Probe({ id }: { id: string }) {
    const count = useRef(0);
    count.current += 1;
    renders[id] = count.current;
    useReplicaQuery((source) => threadOf(source, id), [id]);
    return null;
  }
  render(
    <ReplicaProvider viewer={{ kind: "member", user: testUser(), isAdmin: false }} source={replica}>
      <Probe id={FIRST} />
      <Probe id="01M7HQMDT0RH0G2WHVJHQ6Z8C2" />
    </ReplicaProvider>,
  );
  const before = { ...renders };
  await makeWrites(replica).save(FIRST, true);
  await waitUntil(
    t,
    () => (renders[FIRST] ?? 0) > (before[FIRST] ?? 0),
    "the saved thread re-renders",
  );
  t.is(renders["01M7HQMDT0RH0G2WHVJHQ6Z8C2"], before["01M7HQMDT0RH0G2WHVJHQ6Z8C2"]);
  replica.dispose();
});
