// The shell's sign-in states (phase 2a): a guest and a signed-in account in
// the shell, the guards of the account routes, and the sign-in page's
// redirect.

import { screen } from "@testing-library/react";
import test from "ava";

import { gitHubSignInUrl } from "../src/api/account.js";

import { renderApp, testUser, waitUntil } from "./helpers.js";

test.serial("a guest sees the shell with Sign in", async (t) => {
  const app = await renderApp("/", { user: null });
  await waitUntil(
    t,
    () => screen.queryAllByRole("link", { name: "Sign in" }).length > 0,
    "Sign in",
  );
  t.is(screen.queryByRole("link", { name: "Settings" }), null);
  t.is(app.trpc.calls.filter((c) => c.path === "settings.get").length, 0, "no account reads");
  app.unmount();
});

test.serial(
  "a signed-in account sees its handle, Settings and Sign out; an admin Admin",
  async (t) => {
    const app = await renderApp("/", { user: testUser({ handle: "raymond" }) });
    await waitUntil(
      t,
      () => document.body.textContent?.includes("Signed in as raymond") === true,
      "the handle",
    );
    t.truthy(screen.queryByRole("link", { name: "Settings" }));
    t.truthy(screen.queryByRole("button", { name: "Sign out" }));
    t.is(screen.queryByRole("link", { name: "Admin" }), null);
    app.unmount();
    const admin = await renderApp("/", { user: testUser({ isAdmin: true }) });
    await waitUntil(t, () => screen.queryByRole("link", { name: "Admin" }) !== null, "Admin");
    admin.unmount();
  },
);

test.serial("an account route sends a guest to sign in, and back after", async (t) => {
  const app = await renderApp("/settings", { user: null });
  await waitUntil(t, () => app.router.state.location.pathname === "/login", "to /login");
  t.is((app.router.state.location.search as { redirect?: string }).redirect, "/settings");
  app.unmount();
});

test.serial(
  "the sign-in page sends a signed-in account on, and never off this origin",
  async (t) => {
    const app = await renderApp("/login?redirect=https%3A%2F%2Fevil.example%2F");
    await waitUntil(t, () => app.router.state.location.pathname === "/", "to Home");
    app.unmount();
    t.is(gitHubSignInUrl("/settings", "CODE"), "/auth/github?return_to=%2Fsettings&invite=CODE");
  },
);

test.serial("an invite link signs up with its code", async (t) => {
  const app = await renderApp("/invite?code=ABCD", { user: null });
  await waitUntil(
    t,
    () => screen.queryByRole("button", { name: "Sign up with GitHub" }) !== null,
    "the sign-up button",
  );
  app.unmount();
});
