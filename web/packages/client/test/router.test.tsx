// The route tree (02 W2.1): one test per path, the guards, the feed search
// (`?t=&sel=`, malformed values dropped), the account invite link
// (`/i#<code>`), and the sign-in page's redirects.

import { cleanup, screen } from "@testing-library/react";
import test from "ava";

import { validateFeedSearch } from "../src/app/router.js";
import {
  captureInviteFragment,
  clearPendingInvite,
  readPendingInvite,
} from "../src/lib/pendingInvite.js";

import { renderApp, resetDocumentRoot, testUser, waitUntil } from "./helpers.js";

const waitingUser = () => ({ ...testUser({ login: "new.one" }), status: "waiting" }) as never;

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

test.serial("/i#<code>: the code leaves the URL and waits in memory", async (t) => {
  const app = await renderApp("/i#SESS-9TQ2-X8", { user: null });
  await waitUntil(t, () => app.router.state.location.pathname === "/login", "on to sign in");
  t.false(app.router.state.location.href.includes("SESS"), "no code in the address");
  t.deepEqual(readPendingInvite(), { kind: "account", code: "SESS-9TQ2-X8" });
  app.unmount();

  clearPendingInvite();
  const member = await renderApp("/i#SESS-9TQ2-X8", { user: testUser() });
  await waitUntil(t, () => member.router.state.location.pathname === "/", "signed in: Home");
  t.false(member.router.state.location.href.includes("SESS"));
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
  await renderApp("/login?error=invite_required", { user: null });
  t.is(
    screen.getByRole("alert").textContent,
    "A sign-up code is required to create an account. Open the sign-up link you received.",
  );
});

test.serial("the development kitchen sink is absent outside a development build", async (t) => {
  await renderApp("/dev/ui", { user: null });
  t.is(screen.queryByRole("heading", { name: /Cool · Dark/ }), null);
  t.truthy(screen.getByRole("link", { name: "Session home" }), "the shell still renders");
});
