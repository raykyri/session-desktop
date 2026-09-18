// The route-level error boundary and the 404 route
// (`07-client-architecture.md` §3).

import { screen } from "@testing-library/react";
import test from "ava";

import { renderApp, waitUntil } from "./helpers.js";

test.serial("an address that matches no route renders inside the shell", async (t) => {
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
});

test.serial("a route that throws is contained by the error boundary", async (t) => {
  // A hand-edited search param the route's schema refuses. It is the cheapest
  // throw that comes out of the router's own machinery rather than out of a
  // mock, and it takes the same path a throw inside a streamed markdown render
  // would: with no boundary anywhere on the tree, React unmounts everything
  // and the tab is a blank document.
  const app = await renderApp("/highlights?filter=not-a-filter");
  await waitUntil(
    t,
    () =>
      screen
        .queryAllByRole("alert")
        .some((node) => node.textContent?.includes("could not be shown")),
    "the error panel is shown",
  );
  t.truthy(screen.queryByRole("button", { name: "Reload the page" }), "and it offers a way out");
  app.unmount();
});
