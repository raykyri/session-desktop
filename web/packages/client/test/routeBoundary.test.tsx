// The route-level error boundary and the 404 route
// (`07-client-architecture.md` §3).

import { screen } from "@testing-library/react";
import test from "ava";

import { renderApp, waitUntil } from "./helpers.js";

test.serial("unmatched URL paths render Page not found under the header", async (t) => {
  const app = await renderApp("/not-a-real-page");
  await waitUntil(
    t,
    () => screen.queryByRole("heading", { name: "Page not found" }) !== null,
    "the not-found page is shown rather than a blank page",
  );
  // the page has a way back without reaching for the address bar
  t.truthy(screen.queryByRole("button", { name: "Go to Home" }));
  t.is(
    screen.queryAllByRole("button", { name: "Search" }).length,
    2,
    "the header's and the page's",
  );
  app.unmount();
});

test.serial("a route that throws is contained by the error boundary", async (t) => {
  // Use an invalid query parameter to trigger the router's native error
  // boundary without mocks. The router's own load of the first render
  // rejects with the same error the panel shows; it is not the test's.
  const swallow = (e: unknown) => {
    if (!(e instanceof Error && e.name === "SearchParamError")) throw e;
  };
  process.on("unhandledRejection", swallow);
  t.teardown(() => void process.off("unhandledRejection", swallow));
  const app = await renderApp("/invite?code=1");
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
