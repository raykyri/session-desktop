// The Highlights page (`10-home-feed-journal-encyclopedia.md` §4).

import { screen } from "@testing-library/react";
import test from "ava";

import {
  excerptContext,
  formatHighlightDayLabel,
  groupHighlightsByDay,
} from "../src/features/highlights/HighlightsFeed.js";

import { summary } from "./fixtures.js";
import { renderApp, waitUntil } from "./helpers.js";
import {
  activityPage,
  highlightItem,
  serverSettings,
  workspace,
  WORKSPACE_ID,
} from "./phase6Fixtures.js";

const DAY = 86_400_000;

test("day headers are named in local time, not in UTC", (t) => {
  const now = new Date(2026, 2, 15, 9, 0, 0).getTime();
  t.is(formatHighlightDayLabel(now, now), "Today");
  t.is(formatHighlightDayLabel(new Date(2026, 2, 15, 0, 5).getTime(), now), "Today");
  t.is(formatHighlightDayLabel(new Date(2026, 2, 14, 23, 55).getTime(), now), "Yesterday");
  t.is(formatHighlightDayLabel(new Date(2026, 2, 10).getTime(), now), "Mar 10");
  t.regex(formatHighlightDayLabel(new Date(2024, 2, 10).getTime(), now), /2024/);
});

test("grouping keeps the server's order and starts a section per day", (t) => {
  const now = new Date(2026, 2, 15, 9, 0, 0).getTime();
  const groups = groupHighlightsByDay(
    [
      highlightItem({ highlightId: "a", createdAt: now }),
      highlightItem({ highlightId: "b", createdAt: now - 60_000 }),
      highlightItem({ highlightId: "c", createdAt: now - DAY }),
      highlightItem({ highlightId: "d", createdAt: Number.NaN }),
    ],
    now,
  );
  t.deepEqual(
    groups.map((group) => [group.label, group.items.map((item) => item.highlightId)]),
    [
      ["Today", ["a", "b"]],
      ["Yesterday", ["c"]],
      ["Earlier", ["d"]],
    ],
  );
});

test("context excerpts are trimmed at word boundaries depending on prefix or suffix position", (t) => {
  t.is(excerptContext("short prefix", "prefix"), "short prefix");
  t.is(excerptContext("alpha beta gamma", "suffix", 11), "alpha beta");
  t.is(excerptContext("alpha beta gamma", "prefix", 10), "gamma");
});

test.serial("the feed shows each passage inside its context, under a day header", async (t) => {
  const app = await renderApp("/highlights", {
    responses: {
      "workspaces.list": [workspace()],
      "settings.get": serverSettings(),
      "research.listTrees": [summary({ workspaceId: WORKSPACE_ID })],
      "folders.get": { folders: [], membership: {}, starred: [], collapsed: [] },
      "feed.recentActivity": activityPage([]),
      "highlights.listFeed": [
        highlightItem({ nodeLabel: "Roots", treeTitle: "Collective memory" }),
      ],
      "documents.list": [],
    },
  });

  await waitUntil(
    t,
    () => screen.queryAllByText("a shared store of meaning").length > 0,
    "the highlighted passage is rendered",
  );
  t.truthy(screen.getByText("Today"), "under today's header");
  t.truthy(screen.getByText("Collective memory › Roots"), "and labelled with its thread and node");
  app.unmount();
});
