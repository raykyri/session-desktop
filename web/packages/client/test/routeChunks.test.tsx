// Route-level code splitting (`07-client-architecture.md` §3): the thread
// page, Highlights, Settings and Admin load on demand, the thread route shows
// the page's own loading placeholder while its chunk loads, and a feed card
// starts that load on hover and focus.

import { QueryClient } from "@tanstack/react-query";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { fireEvent, render, screen } from "@testing-library/react";
import test from "ava";

import { queryKeys } from "../src/api/cache.js";
import { AppProviders } from "../src/app/providers.js";
import { createAppRouter } from "../src/app/router.js";
import { FeedCard } from "../src/features/home/FeedCard.js";
import { ThreadPending, threadPlaceholderTitle } from "../src/features/thread/ThreadPending.js";

import { node, summary, tree } from "./fixtures.js";
import { waitUntil } from "./helpers.js";

const LAZY_ROUTES = [
  "/_shell/r/$treeId",
  "/_shell/highlights",
  "/_shell/notifications",
  "/_shell/settings",
  "/_shell/admin",
];
const EAGER_ROUTES = ["/_shell/", "/_shell/f/$folderId", "/_shell/trash", "/login"];

function preloadOf(component: unknown): unknown {
  return (component as { preload?: unknown } | undefined)?.preload;
}

test("secondary routes load their page on demand; Home and the places do not", (t) => {
  const router = createAppRouter({ history: createMemoryHistory({ initialEntries: ["/"] }) });
  const routes = router.routesById as unknown as Record<
    string,
    { options: Record<string, unknown> }
  >;
  for (const id of LAZY_ROUTES) {
    t.is(typeof preloadOf(routes[id]?.options["component"]), "function", `${id} is lazy`);
    t.truthy(routes[id]?.options["pendingComponent"], `${id} has a loading view`);
  }
  for (const id of EAGER_ROUTES) {
    t.is(preloadOf(routes[id]?.options["component"]), undefined, `${id} is in the main chunk`);
  }
  t.is(routes["/_shell/r/$treeId"]?.options["pendingComponent"], ThreadPending);
});

test("the placeholder title is the cached thread's, Note for a note, else Loading research…", (t) => {
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  t.is(threadPlaceholderTitle(client, "t1"), "Loading research…");
  client.setQueryData(queryKeys.trees({ workspaceId: "w1", includeArchived: true }), [
    summary({ id: "t1", title: "Listed title" }),
    summary({ id: "t2", title: "A note", type: "post" }),
  ]);
  t.is(threadPlaceholderTitle(client, "t1"), "Listed title");
  t.is(threadPlaceholderTitle(client, "t2"), "Note");
  client.setQueryData(queryKeys.tree("t1"), {
    tree: tree({ id: "t1", title: "Detail title", rootNodeId: "n1" }),
    nodes: [node({ id: "n1", treeId: "t1" })],
  });
  t.is(threadPlaceholderTitle(client, "t1"), "Detail title", "the detail is preferred");
});

test.serial("the thread route's pending view shows the header and the loading line", async (t) => {
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  client.setQueryData(queryKeys.trees({ workspaceId: "w1", includeArchived: true }), [
    summary({ id: "t1", title: "Listed title" }),
  ]);
  const rootRoute = createRootRoute();
  const threadRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/r/$treeId",
    component: ThreadPending,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([threadRoute]),
    history: createMemoryHistory({ initialEntries: ["/r/t1"] }),
  });
  const view = render(
    <AppProviders queryClient={client}>
      <RouterProvider router={router} />
    </AppProviders>,
  );
  await router.load();
  await waitUntil(
    t,
    () => screen.queryByText("Loading research…") !== null,
    "the loading line is shown",
  );
  t.truthy(screen.queryByText("Listed title"), "the header carries the cached title");
  t.truthy(screen.queryByRole("button", { name: /Back/ }), "Back is in the header");
  view.unmount();
});

test("a card asks for the thread page's chunk on hover and on focus", (t) => {
  let intents = 0;
  const view = render(
    <FeedCard
      cardId="t1"
      place=""
      label="Open thread"
      body="Question"
      onOpen={() => undefined}
      onIntent={() => {
        intents += 1;
      }}
    />,
  );
  const button = screen.getByRole("button", { name: "Open thread" });
  fireEvent.pointerEnter(button);
  t.is(intents, 1);
  fireEvent.focus(button);
  t.is(intents, 2);
  view.unmount();
});
