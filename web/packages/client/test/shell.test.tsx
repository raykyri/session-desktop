// The app bar and the shell per viewer state (02 W2.2, W2.3, W2.7): which
// controls render signed out, without an invite, for a member and for a site
// admin; the strip on each route; the Saved pill, the layout toggle, the
// account menu and its unread dot; the bar hiding on scroll; the footer.

import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import test from "ava";

import { AccountMenu } from "../src/features/shell/AccountMenu.js";
import { ChannelStrip } from "../src/features/shell/ChannelStrip.js";
import { SavedButton } from "../src/features/shell/SavedButton.js";
import { UsageRing } from "../src/features/shell/UsageRing.js";
import type { ShellChannel } from "../src/features/shell/shellData.js";
import { viewerOf } from "../src/features/shell/viewer.js";
import { configureReplica } from "../src/replica/ReplicaProvider.js";
import { FIXTURE_MEMBER } from "../src/replica/fixtureData.js";
import { fixtureReplicaConfig, type FixtureReplica } from "../src/replica/fixtureReplica.js";
import { MemoryReplica } from "../src/replica/memory.js";
import { useNavigationStore } from "../src/stores/navigation.js";

import {
  renderApp,
  renderInRouter,
  resetDocumentRoot,
  testUser,
  waitUntil,
  waitingTestUser,
} from "./helpers.js";

const waitingUser = () => waitingTestUser();

test.beforeEach(() => {
  localStorage.clear();
  useNavigationStore.setState({ scope: "joined", layout: "centred", lastChannel: null });
});

test.afterEach.always(() => {
  cleanup();
  resetDocumentRoot();
  configureReplica(null);
});

/** A loaded replica with nothing in it: every list is known and empty.
 * Without it `renderApp` gives the replica that never loads. */
function loadedEmptyReplica() {
  configureReplica({
    create: (viewer) =>
      new MemoryReplica({
        me: viewer.kind === "signedOut" ? null : (viewer.user.handle ?? viewer.user.login),
        clock: () => Date.now(),
      }),
  });
}

function bar(): HTMLElement {
  const header = document.querySelector<HTMLElement>("header.app-bar");
  if (!header) throw new Error("no app bar");
  return header;
}

function openMenu(trigger: HTMLElement) {
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
}

// ------------------------------------------------------------ viewer states

test.serial("signed out: name, strip of open channels, Join with invite and Sign in", async (t) => {
  await renderApp("/", { user: null });
  const header = within(bar());
  t.truthy(header.getByRole("link", { name: "Session home" }));
  t.truthy(header.getByRole("navigation", { name: "Channels" }));
  t.truthy(header.getByRole("button", { name: "Join with invite" }));
  t.truthy(header.getByRole("button", { name: "Sign in" }));
  // One scope, so no picker; no ring, Saved, layout toggle or account menu.
  t.is(header.queryByRole("button", { name: "All" }), null);
  t.is(header.queryByRole("link", { name: /included tokens/ }), null);
  t.is(header.queryByRole("link", { name: /^Saved/ }), null);
  t.is(header.queryByRole("button", { name: "Expand" }), null);
  t.is(header.queryByRole("button", { name: /^Account/ }), null);
  t.is(header.queryByRole("button", { name: "New channel" }), null, "not a writer");
});

test.serial("Sign in and Join with invite open the auth dialog over this page", async (t) => {
  const app = await renderApp("/browse", { user: null });
  fireEvent.click(within(bar()).getByRole("button", { name: "Sign in" }));
  const dialog = await screen.findByRole("dialog", { name: "Sign in to Session" });
  t.truthy(within(dialog).getByRole("button", { name: "Sign in with X" }));
  t.truthy(within(dialog).getByRole("button", { name: "Sign in with GitHub" }));
  t.is(app.router.state.location.pathname, "/browse");
  fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
  await waitUntil(t, () => screen.queryByRole("dialog") === null, "closed");
  fireEvent.click(within(bar()).getByRole("button", { name: "Join with invite" }));
  t.truthy(await screen.findByRole("heading", { name: "Join with invite?" }));
});

test.serial("without an invite: only the account menu, with Enter an invite code", async (t) => {
  await renderApp("/browse", { user: waitingUser() });
  const header = within(bar());
  t.is(header.queryByRole("link", { name: /included tokens/ }), null);
  t.is(header.queryByRole("link", { name: /^Saved/ }), null);
  t.is(header.queryByRole("button", { name: "New channel" }), null);
  const account = header.getByRole("button", { name: "Account" });
  openMenu(account);
  const menu = await screen.findByRole("menu");
  t.truthy(within(menu).getByText("@new.one · No invite yet"));
  t.truthy(within(menu).getByRole("menuitem", { name: "Enter an invite code" }));
  t.truthy(within(menu).getByRole("menuitem", { name: "Sign out" }));
  t.is(within(menu).queryByRole("menuitem", { name: /Notifications/ }), null);
  t.is(within(menu).queryByRole("menuitem", { name: "Invites" }), null);
});

test.serial("a member: ring, Saved, layout toggle and the full account menu", async (t) => {
  loadedEmptyReplica();
  await renderApp("/", { user: testUser({ login: "ines.v", name: "Ines" }) });
  const header = within(bar());

  const ring = await header.findByRole("link", {
    name: /^2M of 2M included tokens left this week/,
  });
  t.is(ring.textContent, "", "no visible text in the ring");
  t.is(ring.getAttribute("href"), "/usage");

  const saved = header.getByRole("link", { name: "Saved" });
  t.is(saved.textContent, "", "no number at zero");
  t.is(saved.getAttribute("aria-current"), null, "not current off /saved");
  t.is(saved.getAttribute("aria-busy"), null, "the saves are loaded");

  t.truthy(header.getByRole("button", { name: "Expand" }));
  t.truthy(header.getByRole("button", { name: "New channel" }));
  t.truthy(header.getByText("Nothing here yet."));
  t.is(header.getByRole("navigation", { name: "Channels" }).getAttribute("aria-busy"), null);

  openMenu(header.getByRole("button", { name: "Account" }));
  const menu = await screen.findByRole("menu");
  t.truthy(within(menu).getByText("Ines"));
  t.truthy(within(menu).getByText("@ines.v · Member"));
  const items = within(menu)
    .getAllByRole("menuitem")
    .map((item) => item.textContent);
  t.deepEqual(items, ["Notifications", "Invites", "Saved", "Usage and API keys", "Sign out"]);
  t.is(within(menu).queryByRole("menuitem", { name: "Settings" }), null, "P23");
});

test.serial("while the replica loads: no empty line in the strip and no Saved count", async (t) => {
  // `renderApp`'s default replica never loads: every query is unknown.
  await renderApp("/", { user: testUser() });
  const header = within(bar());
  const strip = header.getByRole("navigation", { name: "Channels" });
  t.is(strip.getAttribute("aria-busy"), "true");
  t.is(header.queryByText("Nothing here yet."), null, "not an empty state");
  t.is(within(strip).queryAllByRole("link").length, 0);
  t.truthy(header.getByRole("button", { name: "New channel" }));
  const saved = header.getByRole("link", { name: "Saved" });
  t.is(saved.getAttribute("aria-busy"), "true");
  t.is(saved.textContent, "", "no count");
});

test.serial("Sign out shows the signed-out bar at once, on Home", async (t) => {
  for (const user of [testUser(), waitingUser()]) {
    const app = await renderApp("/browse", { user });
    openMenu(within(bar()).getByRole("button", { name: /^Account/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Sign out" }));
    await waitUntil(
      t,
      () => within(bar()).queryByRole("button", { name: "Sign in" }) !== null,
      `${user.status}: the signed-out bar`,
    );
    t.is(app.router.state.location.pathname, "/", user.status);
    t.is(within(bar()).queryByRole("button", { name: /^Account/ }), null, user.status);
    t.truthy(within(bar()).getByRole("button", { name: "Join with invite" }), user.status);
    t.is(screen.queryByText(/You don't have an invite yet/), null, `${user.status}: no banner`);
    t.is(app.queryClient.getQueryData(["me"]), null, "the cache holds no account");
    app.unmount();
  }
});

test.serial("Site Admin is in the account menu for site admins only", async (t) => {
  await renderApp("/", { user: testUser({ login: "sol", isAdmin: true }) });
  openMenu(within(bar()).getByRole("button", { name: "Account" }));
  const menu = await screen.findByRole("menu");
  t.truthy(within(menu).getByText("@sol · Admin"));
  t.truthy(within(menu).getByRole("menuitem", { name: "Site Admin" }));
});

test.serial("the scope picker offers three radio items to a member", async (t) => {
  loadedEmptyReplica();
  await renderApp("/", { user: testUser() });
  openMenu(within(bar()).getByRole("button", { name: "Joined" }));
  const menu = await screen.findByRole("menu");
  const items = within(menu).getAllByRole("menuitemradio");
  t.deepEqual(
    items.map((item) => item.textContent),
    ["Joined", "Channels you manage", "All"],
  );
  t.is(items[0]?.getAttribute("aria-checked"), "true");
  fireEvent.click(items[1] as HTMLElement);
  await waitUntil(t, () => useNavigationStore.getState().scope === "yours", "scope stored");
  t.truthy(within(bar()).getByText("You have not made a channel yet."));
});

// ------------------------------------------------------------ the phone width

/** `matchMedia` answering the phone query (520 px and below) with `phone`,
 * every other query false; returns the restore. */
function stubWidth(phone: boolean): () => void {
  const before = Object.getOwnPropertyDescriptor(window, "matchMedia");
  window.matchMedia = (query: string) =>
    ({
      matches: phone && query === "(max-width: 520px)",
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
  return () => {
    if (before) Object.defineProperty(window, "matchMedia", before);
  };
}

/** The fixture world's replica, as the viewer `ines.v` reads it. */
function fixtureWorld(): FixtureReplica[] {
  const made: FixtureReplica[] = [];
  configureReplica({
    ...fixtureReplicaConfig({ runMs: null }),
    create: (viewer) => {
      const replica = fixtureReplicaConfig({ runMs: null }).create(viewer) as FixtureReplica;
      made.push(replica);
      return replica;
    },
  });
  return made;
}

test.serial("at the phone width the scope menu lists the strip's channels", async (t) => {
  const restore = stubWidth(true);
  const made = fixtureWorld();
  try {
    const app = await renderApp("/", { user: testUser({ login: FIXTURE_MEMBER }) });
    const strip = within(bar()).getByRole("navigation", { name: "Channels" });
    t.true(strip.classList.contains("phone:hidden"), "the strip is hidden by the phone rule");
    await waitUntil(t, () => within(strip).queryAllByRole("link").length > 1, "channels loaded");
    const chips = within(strip)
      .getAllByRole("link")
      .map((chip) => chip.textContent);

    openMenu(within(bar()).getByRole("button", { name: "Joined" }));
    const menu = await screen.findByRole("menu");
    const radios = within(menu).getAllByRole("menuitemradio");
    t.deepEqual(
      radios.map((item) => item.textContent),
      ["Joined", "Channels you manage", "All", ...chips],
      "the scopes, then the strip's channels in its order",
    );
    t.is(radios[0]?.getAttribute("aria-checked"), "true");
    t.true(radios.slice(3).every((item) => item.getAttribute("aria-checked") === "false"));
    t.truthy(within(menu).getByRole("menuitem", { name: "New channel" }), "a writer");

    // Choosing a channel opens it; the button then names it and its row is
    // checked.
    const target = chips[1] ?? "";
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: target }));
    await waitUntil(
      t,
      () => app.router.state.location.pathname === `/c/${target.slice(1)}`,
      "the channel opened",
    );
    await waitUntil(t, () => screen.queryByRole("menu") === null, "the menu closed");
    const named = within(bar()).getByRole("button", { name: target });
    openMenu(named);
    const again = await screen.findByRole("menu");
    t.is(
      within(again).getByRole("menuitemradio", { name: target }).getAttribute("aria-checked"),
      "true",
    );
  } finally {
    restore();
    for (const replica of made) replica.dispose();
  }
});

test.serial("above the phone width the scope menu lists the scopes only", async (t) => {
  const restore = stubWidth(false);
  const made = fixtureWorld();
  try {
    await renderApp("/", { user: testUser({ login: FIXTURE_MEMBER }) });
    const strip = within(bar()).getByRole("navigation", { name: "Channels" });
    await waitUntil(t, () => within(strip).queryAllByRole("link").length > 1, "channels loaded");
    openMenu(within(bar()).getByRole("button", { name: "Joined" }));
    const menu = await screen.findByRole("menu");
    t.deepEqual(
      within(menu)
        .getAllByRole("menuitemradio")
        .map((item) => item.textContent),
      ["Joined", "Channels you manage", "All"],
    );
    t.is(within(menu).queryByRole("menuitem", { name: "New channel" }), null);
  } finally {
    restore();
    for (const replica of made) replica.dispose();
  }
});

test.serial("signed out at the phone width the menu button stays, with All", async (t) => {
  const restore = stubWidth(true);
  try {
    await renderApp("/", { user: null });
    openMenu(within(bar()).getByRole("button", { name: "All" }));
    const menu = await screen.findByRole("menu");
    t.is(within(menu).getAllByRole("menuitemradio")[0]?.textContent, "All");
    t.is(within(menu).queryByRole("menuitem", { name: "New channel" }), null, "not a writer");
  } finally {
    restore();
  }
});

// ------------------------------------------------------------ the strip per route

test.serial("the strip shows on feeds and the listed pages, not on /welcome", async (t) => {
  for (const path of ["/", "/c/ml", "/browse", "/usage", "/notifications", "/admin"]) {
    const app = await renderApp(path, { user: testUser({ isAdmin: true }) });
    t.truthy(within(bar()).queryByRole("navigation", { name: "Channels" }), path);
    app.unmount();
  }
  const app = await renderApp("/welcome", { user: waitingUser() });
  t.is(within(bar()).queryByRole("navigation", { name: "Channels" }), null, "/welcome");
  app.unmount();
});

// ------------------------------------------------------------ Saved, layout

test.serial("Saved is current only on /saved", async (t) => {
  await renderApp("/saved", { user: testUser() });
  t.is(within(bar()).getByRole("link", { name: "Saved" }).getAttribute("aria-current"), "page");
});

test.serial("the Saved pill shows its count above zero", async (t) => {
  await renderInRouter(<SavedButton count={3} current={false} />);
  const link = screen.getByRole("link", { name: "Saved, 3" });
  t.is(link.textContent, "3");
  t.is(link.getAttribute("title"), "Saved");
});

test.serial("the layout toggle reads Expand in centred and Collapse in wide", async (t) => {
  await renderApp("/", { user: testUser() });
  fireEvent.click(within(bar()).getByRole("button", { name: "Expand" }));
  t.is(useNavigationStore.getState().layout, "wide");
  const collapse = within(bar()).getByRole("button", { name: "Collapse" });
  t.is(collapse.getAttribute("title"), "Collapse");
  t.is(document.querySelector(".feed-inner")?.getAttribute("data-layout"), "wide");
});

test.serial("the layout toggle is on feeds only", async (t) => {
  await renderApp("/browse", { user: testUser() });
  t.is(within(bar()).queryByRole("button", { name: "Expand" }), null);
});

// ------------------------------------------------------------ strip, ring, account dot

const CHANNELS: ShellChannel[] = [
  { id: "1", name: "ml", private: false, joined: true, owned: false, frozen: false },
  { id: "2", name: "history", private: false, joined: false, owned: false, frozen: false },
];

test.serial("strip chips: the current one, Join on unjoined chips under All", async (t) => {
  const joined: string[] = [];
  await renderInRouter(
    <ChannelStrip
      channels={CHANNELS}
      scope="all"
      current="ml"
      canWrite
      onJoin={(channel) => joined.push(channel.name)}
    />,
  );
  t.is(screen.getByRole("link", { name: "#ml" }).getAttribute("aria-current"), "page");
  t.is(screen.getByRole("link", { name: "#history" }).getAttribute("aria-current"), null);
  t.is(screen.getByRole("link", { name: "#ml" }).getAttribute("href"), "/c/ml");
  t.is(screen.queryByRole("button", { name: "Join #ml" }), null, "already joined");
  const join = screen.getByRole("button", { name: "Join #history" });
  t.is(join.getAttribute("title"), "Join");
  fireEvent.click(join);
  t.deepEqual(joined, ["history"]);
  t.truthy(screen.getByRole("button", { name: "New channel" }));
});

test.serial("no Join on a frozen channel's chip, as in Browse and the header", async (t) => {
  await renderInRouter(
    <ChannelStrip
      channels={[
        ...CHANNELS,
        { id: "3", name: "fz-d", private: false, joined: false, owned: false, frozen: true },
      ]}
      scope="all"
      current={null}
      canWrite
    />,
  );
  t.truthy(screen.getByRole("link", { name: "#fz-d" }));
  t.is(screen.queryByRole("button", { name: "Join #fz-d" }), null);
  t.truthy(screen.getByRole("button", { name: "Join #history" }));
});

test.serial("no Join outside All, and none for readers who cannot write", async (t) => {
  await renderInRouter(<ChannelStrip channels={CHANNELS} scope="joined" current={null} canWrite />);
  t.is(screen.queryByRole("button", { name: /^Join/ }), null);
  cleanup();
  await renderInRouter(
    <ChannelStrip channels={CHANNELS} scope="all" current={null} canWrite={false} />,
  );
  t.is(screen.queryByRole("button", { name: /^Join/ }), null);
  t.is(screen.queryByRole("button", { name: "New channel" }), null);
});

test.serial("the strip's fade variables are 0px when it does not overflow", async (t) => {
  await renderInRouter(<ChannelStrip channels={CHANNELS} scope="joined" current={null} canWrite />);
  const strip = document.querySelector<HTMLElement>(".channel-strip");
  t.is(strip?.style.getPropertyValue("--fl"), "0px");
  t.is(strip?.style.getPropertyValue("--fr"), "0px");
});

test.serial("the ring's tone attribute and arc", async (t) => {
  await renderInRouter(
    <UsageRing reading={{ used: 1_900_000, allowance: 2_000_000, resetsAt: null }} />,
  );
  const ring = screen.getByRole("link", { name: /included tokens/ });
  t.is(ring.getAttribute("data-tone"), "bad");
  t.is(ring.textContent, "");
  cleanup();

  // the arc's length over the full circle of radius 7: 2π · 7 = 43.98
  const arc = async (used: number) => {
    await renderInRouter(<UsageRing reading={{ used, allowance: 2_000_000, resetsAt: null }} />);
    const circles = screen
      .getByRole("link", { name: /included tokens/ })
      .querySelectorAll("circle");
    const value = circles[1]?.getAttribute("stroke-dasharray");
    cleanup();
    return value;
  };
  t.is(await arc(2_000_000), "43.98 43.98", "all used: the whole circle");
  t.is(await arc(1_000_000), "21.99 43.98", "half used: half the circle");
});

test.serial(
  "the account avatar carries a dot and a label while notifications are unread",
  async (t) => {
    const viewer = viewerOf(testUser());
    if (viewer.kind === "signedOut") throw new Error("signed in");
    await renderInRouter(<AccountMenu viewer={viewer} unreadCount={2} onSignOut={() => {}} />);
    const button = screen.getByRole("button", { name: "Account, 2 unread notifications" });
    t.truthy(button.querySelector("[data-unread-dot]"));
    cleanup();
    await renderInRouter(<AccountMenu viewer={viewer} unreadCount={1} onSignOut={() => {}} />);
    t.truthy(screen.getByRole("button", { name: "Account, 1 unread notification" }));
    cleanup();
    await renderInRouter(<AccountMenu viewer={viewer} unreadCount={0} onSignOut={() => {}} />);
    t.is(screen.getByRole("button", { name: "Account" }).querySelector("[data-unread-dot]"), null);
  },
);

// ------------------------------------------------------------ W2.3 in the shell

function scrollTo(scroller: HTMLElement, y: number) {
  act(() => {
    scroller.scrollTop = y;
    scroller.dispatchEvent(new Event("scroll"));
  });
}

test.serial("on a feed the bar hides on a scroll down and returns on a scroll up", async (t) => {
  await renderApp("/", { user: testUser() });
  const scroller = document.querySelector<HTMLElement>("[data-shell-scroll]");
  const slot = document.querySelector<HTMLElement>(".app-bar-slot");
  if (!scroller || !slot) throw new Error("no shell");
  const shell = document.querySelector<HTMLElement>(".app-shell");

  scrollTo(scroller, 400);
  t.true(slot.hasAttribute("data-hidden"), "hidden after 400 px down");
  t.true(shell?.hasAttribute("data-bar-hidden"), "the shell knows, for the sticky column");
  t.is(slot.getAttribute("aria-hidden"), null, "stays in the accessibility tree");

  scrollTo(scroller, 350);
  t.false(slot.hasAttribute("data-hidden"), "shown after 50 px up");

  scrollTo(scroller, 800);
  t.true(slot.hasAttribute("data-hidden"));
  act(() => {
    within(bar()).getByRole("link", { name: "Session home" }).focus();
  });
  t.false(slot.hasAttribute("data-hidden"), "focus inside the bar shows it");
});

test.serial("off the feeds the bar does not hide", async (t) => {
  await renderApp("/browse", { user: testUser() });
  const scroller = document.querySelector<HTMLElement>("[data-shell-scroll]");
  const slot = document.querySelector<HTMLElement>(".app-bar-slot");
  if (!scroller || !slot) throw new Error("no shell");
  scrollTo(scroller, 600);
  t.false(slot.hasAttribute("data-hidden"));
});

// ------------------------------------------------------------ W2.7

test.serial("every feed and page ends with the footer, signed in and out", async (t) => {
  const cases: [string, ReturnType<typeof testUser> | null][] = [
    ["/", testUser()],
    ["/c/ml", testUser()],
    ["/saved", testUser()],
    ["/browse", testUser()],
    ["/usage", testUser()],
    ["/notifications", testUser()],
    ["/invites", testUser()],
    ["/admin", testUser({ isAdmin: true })],
    ["/", null],
    ["/c/ml", null],
    ["/browse", null],
  ];
  for (const [path, user] of cases) {
    const app = await renderApp(path, { user });
    const footer = await screen.findByRole("contentinfo");
    t.is(
      footer.textContent,
      "Session · Report abuse: abuse@session.dev",
      `${path} ${user ? "signed in" : "signed out"}`,
    );
    t.is(within(footer).getByRole("link").getAttribute("href"), "mailto:abuse@session.dev");
    // Last in its screen.
    t.is(footer.nextElementSibling, null, path);
    app.unmount();
  }
});
