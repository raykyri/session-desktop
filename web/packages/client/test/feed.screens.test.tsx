// The feed screens on the fixture replica (02 §12.1): the viewer states of
// the card's footer and the composer, the empty states, the channel header
// per relation, the About editor stacked over the info dialog, the layout
// preference. That a write re-renders one row only is in
// `feed.states.test.tsx`.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import test from "ava";

import { InlineComposer } from "../src/features/composer/InlineComposer.js";
import { currentToast } from "../src/features/shell/Toast.js";
import { configureReplica } from "../src/replica/ReplicaProvider.js";
import { fixtureReplicaConfig, type FixtureReplica } from "../src/replica/fixtureReplica.js";
import { makeWrites } from "../src/replica/writes.js";
import { useDraftsStore } from "../src/stores/drafts.js";
import { useNavigationStore } from "../src/stores/navigation.js";

import { renderApp, renderInRouter, waitUntil, waitingTestUser } from "./helpers.js";

const FIRST = "01M7HWGZJGT7JTFFVSYPX055KV";
const waiting = () => waitingTestUser();

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

/** The first stroke of the pencil icon (`PencilIcon`, the mock's `PENCIL`). */
const PENCIL_PATH = "M10.8 2.7a1.6 1.6 0 0 1 2.3 2.3L5.6 12.5 2.5 13.5l1-3.1Z";

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

test.serial(
  "a post's channel is in its footer, as an ask's is, not beside its title",
  async (t) => {
    await renderApp("/");
    await waitUntil(t, () => document.querySelector(".tcard") !== null, "threads render");
    const cards = [...document.querySelectorAll<HTMLElement>(".tcard")];
    const post = cards.find((c) => within(c).queryByRole("button", { name: /^Reply/ }) !== null);
    const ask = cards.find((c) => within(c).queryByRole("button", { name: /^Ask a follow-up/ }));
    if (!post || !ask) throw new Error("no post or ask card");
    t.regex(post.querySelector(".card-f .fmeta")?.textContent ?? "", /^#[a-z0-9-]+$/);
    t.regex(ask.querySelector(".card-f .fmeta")?.textContent ?? "", / · #[a-z0-9-]+$/);
    t.is(
      post.querySelector(".tt")?.textContent?.includes("#"),
      false,
      "no channel in the title row",
    );
  },
);

test.serial("without an invite: the banner, no composer, disabled write controls", async (t) => {
  await renderApp("/", { user: waiting() });
  await waitUntil(t, () => document.querySelector(".tcard") !== null, "threads render");
  t.truthy(screen.getByText(/You don.t have an invite yet\./));
  t.is(screen.queryByRole("textbox", { name: "Ask or post" }), null);
  const first = document.querySelector<HTMLElement>(".tcard");
  if (!first) throw new Error("no card");
  const save = within(first).getByRole("button", { name: /^Save/ });
  t.true((save as HTMLButtonElement).disabled);
  t.is(save.getAttribute("title"), "Available once you have an invite");
});

test.serial("signed out: the composer is a cover that opens sign-in", async (t) => {
  const result = await renderApp("/", { user: null });
  await waitUntil(t, () => document.querySelector(".tcard") !== null, "threads render");
  const cover = screen.getByRole("button", { name: "Sign in to ask or post" });
  fireEvent.click(cover);
  t.truthy(await screen.findByRole("dialog", { name: "Sign in to Session" }), "sign-in opens");
  t.is(result.router.state.location.pathname, "/");
});

test.serial(
  "the composer: mode, placeholder, the model picker only for asks, the empty state",
  async (t) => {
    await renderApp("/");
    const field = await screen.findByRole("textbox", { name: "Ask or post" });
    t.is(field.getAttribute("placeholder"), "Ask anything");
    const send = screen.getByRole("button", { name: "Ask" });
    t.true((send as HTMLButtonElement).disabled);
    t.is(send.querySelector("path")?.getAttribute("d"), "M3 8h10", "the send arrow for Ask");
    t.truthy(screen.getByTitle("Model and effort"));
    t.truthy(screen.getByTitle("Channel"));
    // The member's avatar at the start.
    t.is(document.querySelector(".nb .nb-av")?.textContent, "IV");
    fireEvent.click(screen.getByRole("button", { name: "Ask or post" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /^Post/ }));
    await waitUntil(t, () => field.getAttribute("placeholder") === "Write a post", "post mode");
    t.is(screen.queryByTitle("Model and effort"), null);
    // The main action shows the pencil of the Post row, not the send arrow.
    const post = screen.getByRole("button", { name: "Post" });
    t.is(post.querySelector("path")?.getAttribute("d"), PENCIL_PATH);
    fireEvent.change(field, { target: { value: "hello" } });
    t.false(screen.getByRole("button", { name: "Post" }).hasAttribute("disabled"));
    t.is(useDraftsStore.getState().byKey["new"]?.text, "hello");
  },
);

/** The declarations of the last top-level rule for `selector` in
 * `spaces.css`, whitespace collapsed. */
function spacesRule(selector: string): string {
  const css = readFileSync(join(import.meta.dirname, "..", "src", "styles", "spaces.css"), "utf8");
  const at = css.lastIndexOf(`\n${selector} {`);
  if (at < 0) return "";
  return css.slice(at, css.indexOf("}", at)).replace(/\s+/g, " ");
}

test.serial(
  "the composer: with text its controls take a row under the field; cleared, one row",
  async (t) => {
    await renderApp("/");
    const field = await screen.findByRole("textbox", { name: "Ask or post" });
    const form = field.closest("form") as HTMLFormElement;
    t.false(form.classList.contains("open"), "empty: one row");
    field.focus();
    fireEvent.change(field, { target: { value: " " } });
    t.true(form.classList.contains("open"), "any text, whitespace too");
    t.is(document.activeElement, field, "focus stays in the field");
    // the stylesheet wraps the open composer: the field fills the row after
    // the avatar, so the controls go to the next one
    t.regex(spacesRule(".nb.open"), /flex-wrap: wrap/);
    t.regex(spacesRule(".nb.open > textarea"), /flex: 1 1 calc\(100% - 28px\)/);
    t.regex(spacesRule(".nb > textarea"), /max-height: min\(480px, calc\(100vh - 80px\)\)/);
    fireEvent.change(field, { target: { value: "" } });
    t.false(form.classList.contains("open"), "cleared: one row again");
  },
);

test.serial("an inline composer: with text Close and its button go under the field", async (t) => {
  await renderInRouter(
    <InlineComposer
      draftKey="test:inline"
      placeholder="Reply"
      submitLabel="Reply"
      onSubmit={() => Promise.resolve(true)}
      onClose={() => {}}
      focusOnOpen={false}
    />,
  );
  const field = screen.getByRole("textbox", { name: "Reply" });
  const form = field.closest("form") as HTMLFormElement;
  t.false(form.classList.contains("open"));
  fireEvent.change(field, { target: { value: "a" } });
  t.true(form.classList.contains("open"));
  t.regex(spacesRule(".icomp.open"), /flex-wrap: wrap/);
  t.regex(spacesRule(".icomp.open textarea"), /flex: 1 1 100%/);
  t.regex(spacesRule(".icomp textarea"), /max-height: min\(320px, calc\(100vh - 80px\)\)/);
  fireEvent.change(field, { target: { value: "" } });
  t.false(form.classList.contains("open"));
});

test.serial("empty states: Saved, and a channel without threads", async (t) => {
  await renderApp("/saved");
  const heading = await screen.findByRole("heading", { name: "No saved threads" });
  t.is(heading.parentElement?.querySelector("p"), null, "no explanation");
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
  t.truthy(screen.getByText("This channel is private. You need an invite link to join."));
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
