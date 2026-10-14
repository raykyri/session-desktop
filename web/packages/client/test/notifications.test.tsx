// The notification inbox (`10-home-feed-journal.md` §4c): the page, marking
// read, paging, and the event bridge keeping it current whatever the
// Notifications setting says.

import type { InboxNotification } from "@session/shared";
import { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import test from "ava";

import { applyEventBatch } from "../src/api/events.js";
import { queryClientDefaults, queryKeys } from "../src/api/queries.js";
import { useNotificationsStore } from "../src/stores/notifications.js";
import { useSettingsStore } from "../src/stores/settings.js";

import { renderApp, resetDocumentRoot, waitUntil } from "./helpers.js";

test.afterEach.always(() => {
  cleanup();
  resetDocumentRoot();
  useNotificationsStore.getState().clear();
  useSettingsStore.getState().patch({ showNotifications: true });
});

function testQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { ...queryClientDefaults.queries, gcTime: Number.POSITIVE_INFINITY },
      mutations: { gcTime: Number.POSITIVE_INFINITY },
    },
  });
}

function entry(id: string, overrides: Partial<InboxNotification> = {}): InboxNotification {
  return {
    id,
    kind: "followUp",
    tone: "info",
    treeId: "t1",
    title: `New question in Thread ${id}`,
    body: `ada: question ${id}`,
    href: `/r/t1?sel=${id}`,
    createdAt: 1_700_000_000_000,
    readAt: null,
    ...overrides,
  };
}

test.serial(
  "the inbox lists notifications; opening one marks it read and follows it",
  async (t) => {
    const { router, trpc, queryClient } = await renderApp("/notifications", {
      queryClient: testQueryClient(),
      responses: {
        "notifications.list": {
          items: [entry("n1"), entry("n2", { readAt: 5 })],
          nextCursor: null,
        },
        "notifications.unreadCount": { count: 1 },
        "notifications.markRead": { changed: true },
        "research.getTree": () => ({ tree: { id: "t1" }, nodes: [] }),
      },
    });
    await screen.findByRole("heading", { name: "Notifications", level: 1 });
    const list = await screen.findByRole("list", { name: "Notifications" });
    const unread = within(list).getByRole("button", { name: "Unread: New question in Thread n1" });
    t.truthy(within(list).getByRole("button", { name: "New question in Thread n2" }));
    t.truthy(screen.getByRole("link", { name: "Notifications, 1 unread" }));

    fireEvent.click(unread);
    await waitUntil(t, () => router.state.location.pathname === "/r/t1", "the thread opens");
    t.deepEqual(trpc.calls.find((call) => call.path === "notifications.markRead")?.input, {
      id: "n1",
    });
    t.deepEqual(queryClient.getQueryData(queryKeys.unreadNotifications()), { count: 0 });
  },
);

test.serial("Mark all as read, and older notifications a page at a time", async (t) => {
  const { trpc } = await renderApp("/notifications", {
    queryClient: testQueryClient(),
    responses: {
      "notifications.list": (input: { cursor?: string | null } | undefined) =>
        input?.cursor === "c1"
          ? { items: [entry("old")], nextCursor: null }
          : { items: [entry("new")], nextCursor: "c1" },
      "notifications.unreadCount": { count: 2 },
      "notifications.markAllRead": { count: 2 },
    },
  });
  const older = await screen.findByRole("button", { name: "Show older notifications" });
  fireEvent.click(older);
  await screen.findByRole("button", { name: "Unread: New question in Thread old" });
  t.is(screen.queryByRole("button", { name: "Show older notifications" }), null);

  const markAll = screen.getByRole("button", { name: "Mark all as read" });
  fireEvent.click(markAll);
  await waitUntil(
    t,
    () => trpc.calls.some((call) => call.path === "notifications.markAllRead"),
    "mark all read",
  );
  await screen.findByRole("button", { name: "New question in Thread old" });
  t.truthy(screen.getByRole("button", { name: "New question in Thread new" }));
  t.true(screen.getByRole<HTMLButtonElement>("button", { name: "Mark all as read" }).disabled);
});

test.serial("an empty inbox says so", async (t) => {
  await renderApp("/notifications", { queryClient: testQueryClient() });
  t.truthy(await screen.findByText("No notifications."));
});

test.serial("a server notification refetches the inbox even with toasts off", (t) => {
  const client = testQueryClient();
  client.setQueryData(queryKeys.unreadNotifications(), { count: 0 });
  useSettingsStore.getState().patch({ showNotifications: false });
  applyEventBatch(
    [
      {
        type: "notification.requested",
        payload: {
          id: "n9",
          title: "Research finished",
          body: "",
          tone: "success",
          timeoutMs: 5_000,
          createdAt: 1,
          kind: "runFinished",
        },
        timestamp: 1,
      },
    ],
    client,
  );
  t.true(client.getQueryState(queryKeys.unreadNotifications())?.isInvalidated ?? false);
  t.deepEqual(useNotificationsStore.getState().items, [], "no toast");

  client.setQueryData(queryKeys.unreadNotifications(), { count: 1 });
  applyEventBatch([{ type: "notifications.read", payload: {}, timestamp: 2 }], client);
  t.true(client.getQueryState(queryKeys.unreadNotifications())?.isInvalidated ?? false);
});
