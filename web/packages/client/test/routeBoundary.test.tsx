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
    // Inside the shell: the sidebar is still mounted, so the tab has a way back
    // without reaching for the address bar.
    t.truthy(screen.queryByRole("link", { name: "Go to Home" }));
    t.truthy(document.querySelector("aside, nav"), "the shell frame is still rendered");
    app.unmount();
  },
);

test.serial("a route that throws is contained by the error boundary", async (t) => {
  // Use an invalid query parameter to trigger the router's native error
  // boundary without mocks.
  const app = await renderApp("/highlights?filter=not-a-filter");
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
