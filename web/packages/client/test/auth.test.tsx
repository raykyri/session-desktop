// Sign-in states (phase 2b): a guest and a signed-in account in the spaces
// header, the guards of the account routes, the sign-in page's redirect, and
// the plain routes in place of tRPC.

import { cleanup, fireEvent, screen } from "@testing-library/react";
import test from "ava";

import { gitHubSignInUrl } from "../src/api/account.js";

import { renderApp, resetDocumentRoot, testUser, waitUntil } from "./helpers.js";

test.afterEach.always(() => {
  cleanup();
  resetDocumentRoot();
});

test.serial("a guest sees Log in and Sign up, and no account reads are made", async (t) => {
  const app = await renderApp("/", { user: null });
  await waitUntil(t, () => screen.queryByRole("button", { name: "Log in" }) !== null, "Log in");
  t.truthy(screen.queryByRole("button", { name: "Sign up" }));
  t.is(screen.queryByRole("button", { name: /^Account/ }), null);
  t.is(
    app.server.calls.filter((c) => c.path === "/api/me/preferences").length,
    0,
    "no account reads",
  );
  // a guest reads no sync log as a person
  t.is(app.server.calls.filter((c) => c.path === "/api/sync/register").length, 0);
});

test.serial("a signed-in account has the account menu, and signs out", async (t) => {
  const app = await renderApp("/", { user: testUser({ handle: "raymond", u: "raymond" }) });
  const menu = await screen.findByRole("button", { name: "Account: raymond" });
  fireEvent.click(menu);
  t.truthy(screen.getByRole("menu", { name: "Account" }));
  app.server.routes.set("POST /auth/logout", new Response(null, { status: 204 }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Sign out" }));
  await waitUntil(t, () => screen.queryByRole("button", { name: "Log in" }) !== null, "signed out");
  const out = app.server.calls.find((c) => c.path === "/auth/logout");
  t.is(out?.method, "POST");
  t.is(out?.headers.get("X-Requested-With"), "session", "the CSRF header");
});

test.serial("the signed-in session reads its user log over the sync routes", async (t) => {
  const app = await renderApp("/", { user: testUser({ handle: "raymond", u: "raymond" }) });
  await waitUntil(
    t,
    () =>
      app.server.calls.some(
        (c) =>
          c.path === "/api/sync/snapshot" && (c.body as { log: string }).log === "user:raymond",
      ),
    "a snapshot of user:raymond",
  );
  const reg = app.server.calls.find((c) => c.path === "/api/sync/register");
  t.is(reg?.headers.get("X-Requested-With"), "session");
});

test.serial("an account route sends a guest to sign in, and back after", async (t) => {
  const app = await renderApp("/settings", { user: null });
  await waitUntil(t, () => app.router.state.location.pathname === "/login", "to /login");
  t.is((app.router.state.location.search as { redirect?: string }).redirect, "/settings");
});

test.serial(
  "the sign-in page sends a signed-in account on, and never off this origin",
  async (t) => {
    const app = await renderApp("/login?redirect=https%3A%2F%2Fevil.example%2F");
    await waitUntil(t, () => app.router.state.location.pathname === "/", "to Home");
    t.is(gitHubSignInUrl("/settings", "CODE"), "/auth/github?return_to=%2Fsettings&invite=CODE");
  },
);

test.serial("an invite link signs up with its code", async (t) => {
  await renderApp("/invite?code=ABCD", { user: null });
  await waitUntil(
    t,
    () => screen.queryByRole("button", { name: "Sign up with GitHub" }) !== null,
    "the sign-up button",
  );
});
