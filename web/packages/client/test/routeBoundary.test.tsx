// The route-level error boundary and the 404 route
// (`07-client-architecture.md` §3).

import { screen } from "@testing-library/react";
import test from "ava";

import { renderApp, testUser, waitUntil } from "./helpers.js";

test.serial(
  "unmatched URL paths render the not-found view within the application shell",
  async (t) => {
    const app = await renderApp("/not-a-real-page");
    await waitUntil(
      t,
      () => screen.queryAllByRole("alert").some((node) => node.textContent?.includes("Not found")),
      "the 404 panel is shown rather than a blank page",
    );
    // Inside the shell: the app bar is still mounted, so the tab has a way
    // back without reaching for the address bar.
    t.truthy(screen.queryByRole("link", { name: "Go to Home" }));
    t.truthy(screen.queryByRole("link", { name: "Session home" }), "the app bar is still rendered");
    app.unmount();
  },
);

for (const [path, why] of [
  ["/admin", "a member who is not a site admin"],
  ["/c/BAD_NAME", "a channel path whose name is not a channel name"],
] as const)
  test.serial(`not found for ${why} (${path}) keeps the app bar`, async (t) => {
    const app = await renderApp(path, { user: testUser({ isAdmin: false }) });
    await waitUntil(
      t,
      () => screen.queryAllByRole("alert").some((node) => node.textContent?.includes("Not found")),
      "the 404 panel",
    );
    t.truthy(screen.queryByRole("link", { name: "Session home" }), "the app bar is rendered");
    // a client-side navigation there does the same
    await app.router.navigate({ to: "/" });
    await waitUntil(
      t,
      () => !screen.queryAllByRole("alert").some((n) => n.textContent?.includes("Not found")),
      "Home",
    );
    await app.router.navigate({ href: path });
    await waitUntil(
      t,
      () => screen.queryAllByRole("alert").some((node) => node.textContent?.includes("Not found")),
      "the 404 panel again",
    );
    t.truthy(screen.queryByRole("link", { name: "Session home" }), "the app bar is rendered");
    app.unmount();
  });

test.serial("a route that throws is contained by the error boundary", async (t) => {
  // The router parses `?redirect=12` as a number, which fails the login
  // route's schema: the router reports that through the error boundary.
  const app = await renderApp("/login?redirect=12", { user: null });
  await waitUntil(
    t,
    () =>
      screen
        .queryAllByRole("alert")
        .some((node) => node.textContent?.includes("Unable to load this page")),
    "the error panel is shown",
  );
  t.truthy(screen.queryByRole("button", { name: "Reload the page" }), "and it offers a way out");
  app.unmount();
});
