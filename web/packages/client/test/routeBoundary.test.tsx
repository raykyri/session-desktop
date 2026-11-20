// The route-level error boundary and the 404 route
// (`07-client-architecture.md` §3).

import { screen } from "@testing-library/react";
import test from "ava";

import { renderApp, waitUntil } from "./helpers.js";

test.serial(
  "unmatched URL paths render the not-found view within the application shell",
  async (t) => {
    const app = await renderApp("/not-a-real-page");
    await waitUntil(
      t,
      () => screen.queryByRole("alert")?.textContent?.includes("Not found") === true,
      "the 404 panel is shown rather than a blank page",
    );
    // Inside the shell: the app bar is still mounted, so the tab has a way
    // back without reaching for the address bar.
    t.truthy(screen.queryByRole("link", { name: "Go to Home" }));
    t.truthy(screen.queryByRole("link", { name: "Session home" }), "the app bar is still rendered");
    app.unmount();
  },
);

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
