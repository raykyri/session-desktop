// The route tree (02 W2.1): one test per path, the guards, the feed search
// (`?t=&sel=`, malformed values dropped), the account invite link
// (`/i#<code>`), and the sign-in page's redirects.

import { act, cleanup, screen } from "@testing-library/react";
import test from "ava";

import { validateFeedSearch } from "../src/app/router.js";
import {
  captureInviteFragment,
  clearPendingInvite,
  readPendingInvite,
} from "../src/lib/pendingInvite.js";

import { renderApp, resetDocumentRoot, testUser, waitUntil, waitingTestUser } from "./helpers.js";

const waitingUser = () => waitingTestUser();

/** A valid ULID. */
const THREAD = "01JD3Q9ZK4M7V2X8N5B6C1T0RS";
const NODE = "01JD3QA0B1C2D3E4F5G6H7J8KM";

test.afterEach.always(() => {
  cleanup();
  resetDocumentRoot();
  clearPendingInvite();
});

const heading = (name: string) => screen.findByRole("heading", { name });

test.serial("each path renders its screen", async (t) => {
  const member = testUser({ isAdmin: true });
  const feeds = ["/", "/c/reading-group", "/saved"];
  for (const path of feeds) {
    const app = await renderApp(path, { user: member });
    t.truthy(document.querySelector(".feed-inner"), `${path} is a feed`);
    t.truthy(screen.getByRole("status", { name: "Loading" }), `${path} has its placeholder row`);
    app.unmount();
  }
  const pages: [string, string][] = [
    ["/browse", "Browse channels"],
    ["/invites", "Invites"],
    ["/usage", "Usage and API keys"],
    ["/notifications", "Notifications"],
    ["/admin", "Site Admin"],
    ["/settings", "Settings"],
  ];
  for (const [path, name] of pages) {
    const app = await renderApp(path, { user: member });
    t.truthy(await heading(name), path);
    app.unmount();
  }
  const app = await renderApp("/welcome", { user: waitingUser() });
  t.truthy(await heading("Invite required"), "/welcome");
  app.unmount();
});

test.serial("a route change to a page focuses its heading without scrolling", async (t) => {
  const app = await renderApp("/", { user: testUser({ isAdmin: true }) });
  const scroller = document.querySelector<HTMLElement>("[data-shell-scroll]");
  const pages: [string, string][] = [
    ["/browse", "Browse channels"],
    ["/invites", "Invites"],
    ["/usage", "Usage and API keys"],
    ["/notifications", "Notifications"],
    ["/admin", "Site Admin"],
  ];
  for (const [path, name] of pages) {
    await act(() => app.router.navigate({ to: path }));
    const page = await heading(name);
    await waitUntil(t, () => document.activeElement === page, `${path}: heading focused`);
    t.is(page.getAttribute("tabindex"), "-1", `${path}: focusable by script only`);
    t.is(scroller?.scrollTop, 0, `${path}: not scrolled`);
  }
  app.unmount();

  const waiting = await renderApp("/", { user: waitingUser() });
  await act(() => waiting.router.navigate({ to: "/welcome" }));
  const welcome = await heading("Invite required");
  await waitUntil(t, () => document.activeElement === welcome, "/welcome: heading focused");
});

test.serial("the page the app loads on leaves focus at the start", async (t) => {
  const app = await renderApp("/browse", { user: testUser() });
  const page = await heading("Browse channels");
  t.is(page.getAttribute("tabindex"), "-1");
  t.not(document.activeElement, page, "Tab reaches the app bar first");
  app.unmount();
});

test.serial("a channel path with an invalid name is not found", async (t) => {
  await renderApp("/c/Not_A_Channel", { user: testUser() });
  await waitUntil(
    t,
    () => screen.queryByRole("alert")?.textContent?.includes("Not found") === true,
    "not found",
  );
});

test.serial("an account without an invite goes from /invites and /usage to /welcome", async (t) => {
  for (const path of ["/invites", "/usage"]) {
    const app = await renderApp(path, { user: waitingUser() });
    await waitUntil(t, () => app.router.state.location.pathname === "/welcome", path);
    app.unmount();
  }
});

test.serial("a member is not kept on /welcome; a signed-out visitor signs in first", async (t) => {
  const member = await renderApp("/welcome", { user: testUser() });
  await waitUntil(t, () => member.router.state.location.pathname === "/", "member to Home");
  member.unmount();
  for (const path of ["/invites", "/usage", "/saved", "/notifications", "/welcome"]) {
    const app = await renderApp(path, { user: null });
    await waitUntil(t, () => app.router.state.location.pathname === "/login", path);
    t.is(app.router.state.location.search.redirect, path);
    app.unmount();
  }
});

test.serial("signed out, the feeds and Browse are readable", async (t) => {
  for (const path of ["/", "/c/ml", "/browse"]) {
    const app = await renderApp(path, { user: null });
    t.is(app.router.state.location.pathname, path);
    app.unmount();
  }
});

test("the feed search keeps valid ids and drops malformed ones", (t) => {
  const none = { t: undefined, sel: undefined };
  t.deepEqual(validateFeedSearch({ t: THREAD, sel: NODE }), { t: THREAD, sel: NODE });
  t.deepEqual(validateFeedSearch({ t: THREAD, sel: "not-an-id" }), { t: THREAD, sel: undefined });
  t.deepEqual(validateFeedSearch({ t: THREAD, sel: 42 }), { t: THREAD, sel: undefined });
  t.deepEqual(validateFeedSearch({ t: THREAD.toLowerCase() }), none, "ULIDs are upper case");
  t.deepEqual(validateFeedSearch({ sel: `${NODE}x` }), none);
  t.deepEqual(validateFeedSearch({}), none);
});

test.serial("a thread address keeps t and drops a malformed sel", async (t) => {
  const app = await renderApp(`/c/ml?t=${THREAD}&sel=%3Cscript%3E`, { user: testUser() });
  const match = app.router.state.matches.find(
    (candidate) => candidate.routeId === "/_shell/c/$name",
  );
  t.is(match?.search.t, THREAD);
  t.is(match?.search.sel, undefined, "the malformed value does not reach the screen");
});

test.serial("/i#<code>: the code leaves the URL and the dialog shows the inviter", async (t) => {
  const app = await renderApp("/i#SESS-9TQ2-X8", {
    user: null,
    responses: {
      "auth.checkInvite": () => ({
        status: "open",
        inviter: { name: "Ines Vidal", handle: "ines.v" },
      }),
    },
  });
  await waitUntil(t, () => app.router.state.location.pathname === "/", "on to Home");
  t.false(app.router.state.location.href.includes("SESS"), "no code in the address");
  t.truthy(await screen.findByText("Ines Vidal invited you to Session"));
  t.deepEqual(app.trpc.calls.find((call) => call.path === "auth.checkInvite")?.input, {
    code: "SESS-9TQ2-X8",
  });
  t.is(readPendingInvite(), null, "taken out of memory once shown");
  app.unmount();

  const member = await renderApp("/i#SESS-9TQ2-X8", { user: testUser() });
  await waitUntil(t, () => member.router.state.location.pathname === "/", "signed in: Home");
  t.false(member.router.state.location.href.includes("SESS"));
  t.is(screen.queryByRole("dialog"), null, "a member's link is dropped");
});

test.serial(
  "/c/<name>#<code>: the route keeps the code and replaces the entry without it, on a load and a same-document navigation",
  async (t) => {
    // a channel the fixtures do not have, so no join drops the code
    const app = await renderApp("/c/reading-group#k3v8q2m9", { user: null });
    await waitUntil(t, () => app.router.state.location.hash === "", "the fragment is gone");
    t.is(app.router.state.location.pathname, "/c/reading-group");
    t.false(app.router.state.location.href.includes("k3v8q2m9"));
    t.deepEqual(readPendingInvite(), {
      kind: "channel",
      channel: "reading-group",
      code: "k3v8q2m9",
    });
    clearPendingInvite();
    act(() => app.router.history.push(`/c/other-group?t=${THREAD}#x7c4b6n1`));
    await waitUntil(
      t,
      () => app.router.state.location.pathname === "/c/other-group",
      "the navigation lands",
    );
    await waitUntil(t, () => app.router.state.location.hash === "", "the fragment is gone");
    t.false(app.router.state.location.href.includes("x7c4b6n1"));
    t.is((app.router.state.location.search as { t?: string }).t, THREAD, "the search stays");
    t.deepEqual(readPendingInvite(), {
      kind: "channel",
      channel: "other-group",
      code: "x7c4b6n1",
    });
    t.false(app.router.history.location.href.includes("x7c4b6n1"), "the history entry has no code");
  },
);

test.serial("/notifications sends an account without an invite to /welcome", async (t) => {
  const app = await renderApp("/notifications", { user: waitingUser() });
  await waitUntil(t, () => app.router.state.location.pathname === "/welcome", "on to /welcome");
  t.pass();
});

test("a page load takes the code out of the address before the router starts", (t) => {
  const replaced: string[] = [];
  const history = {
    state: null,
    replaceState: (_state: unknown, _title: string, url?: string | URL | null) => {
      replaced.push(String(url));
    },
  };
  t.deepEqual(
    captureInviteFragment({ pathname: "/i", search: "", hash: "#SESS-9TQ2-X8" }, history),
    { kind: "account", code: "SESS-9TQ2-X8" },
  );
  t.deepEqual(replaced, ["/i"]);
  t.deepEqual(captureInviteFragment({ pathname: "/c/ml", search: "?t=x", hash: "#abc" }, history), {
    kind: "channel",
    channel: "ml",
    code: "abc",
  });
  t.deepEqual(replaced, ["/i", "/c/ml?t=x"]);
  t.is(captureInviteFragment({ pathname: "/browse", search: "", hash: "#top" }, history), null);
  t.is(replaced.length, 2, "other fragments stay");
});

test.serial("a signed-in visit to /login goes on to the requested page", async (t) => {
  const app = await renderApp("/login?redirect=%2Fsettings", { user: testUser() });
  t.truthy(await heading("Settings"));
  t.is(screen.queryByRole("button", { name: /Sign in with GitHub/ }), null);
  app.unmount();
});

test.serial("a redirect that leaves this origin is not followed", async (t) => {
  const app = await renderApp("/login?redirect=%2F%2Fevil.example%2Fsteal", { user: testUser() });
  t.is(app.router.state.location.pathname, "/");
});

test.serial("the sign-in page shows the server's refusal", async (t) => {
  await renderApp("/login?error=too_many_accounts", { user: null });
  t.is(
    screen.getByRole("alert").textContent,
    "Too many new accounts were made from your network today. Try again tomorrow.",
  );
  t.truthy(screen.getByRole("button", { name: "Sign in with GitHub" }));
  t.truthy(screen.getByRole("button", { name: "Sign in with X" }));
});

test.serial("the development kitchen sink is absent outside a development build", async (t) => {
  await renderApp("/dev/ui", { user: null });
  t.is(screen.queryByRole("heading", { name: /Cool · Dark/ }), null);
  t.truthy(screen.getByRole("link", { name: "Session home" }), "the shell still renders");
});
