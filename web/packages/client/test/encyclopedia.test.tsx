// Encyclopedia pages and wikilink activation
// (`10-home-feed-journal-encyclopedia.md` §6).

import { ENCYCLOPEDIA_EXCERPT_CHAR_LIMIT } from "@session/shared";
import { fireEvent, screen } from "@testing-library/react";
import test from "ava";

import { shortExcerpt, sourceLabel } from "../src/features/encyclopedia/EncyclopediaPageView.js";
import {
  statusForSlug,
  wikilinkClickContext,
} from "../src/features/encyclopedia/wikilinkActions.js";

import { summary } from "./fixtures.js";
import { renderApp, waitUntil } from "./helpers.js";
import {
  activityPage,
  encyclopediaPage,
  pageSummary,
  serverSettings,
  testQueryClient,
  workspace,
  WORKSPACE_ID,
} from "./phase6Fixtures.js";

function render(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.appendChild(host);
  return host;
}

test("returns the page status for existing encyclopedia terms, or null if not found", (t) => {
  const pages = [pageSummary(), pageSummary({ slug: "amnesia", status: "generating" })];
  t.is(statusForSlug(pages, "collective-memory"), "ready");
  t.is(statusForSlug(pages, "amnesia"), "generating");
  t.is(statusForSlug(pages, "unwritten"), null);
  t.is(statusForSlug(undefined, "collective-memory"), null);
});

test("the click context is the passage the term was read in, plus its neighbors", (t) => {
  const host = render(
    `<div class="research-prose">
      <p>Earlier context.</p>
      <p id="block">Memory is <a data-wikilink="Collective memory">collective memory</a>
        beside <a data-wikilink="Amnesia">amnesia</a>.</p>
      <p>Later context.</p>
    </div>`,
  );
  const anchor = host.querySelector<HTMLElement>('[data-wikilink="Collective memory"]');
  const context = wikilinkClickContext(anchor as HTMLElement, "Collective memory");

  t.true(context.excerpt.includes("Memory is collective memory beside amnesia."));
  t.true(context.excerpt.includes("Earlier context."), "the previous block is kept when it fits");
  t.true(context.excerpt.includes("Later context."), "and the next one too");
  t.deepEqual(context.siblingTerms, ["Amnesia"], "the clicked term is not its own sibling");
  host.remove();
});

test("the excerpt is capped at the shared limit", (t) => {
  const host = render(`<p id="block">${"word ".repeat(1_000)}</p>`);
  const block = host.querySelector<HTMLElement>("#block");
  const context = wikilinkClickContext(block as HTMLElement, "Anything");
  t.true(context.excerpt.length <= ENCYCLOPEDIA_EXCERPT_CHAR_LIMIT);
  host.remove();
});

test("a backlink is labelled by the question that asked for the page", (t) => {
  t.is(
    sourceLabel({ question: "What is collective memory?", excerpt: "", createdAt: 1 }),
    "What is collective memory?",
  );
  t.is(sourceLabel({ pageSlug: "amnesia", excerpt: "", createdAt: 1 }), "Encyclopedia page");
  t.is(sourceLabel({ excerpt: "", createdAt: 1 }), "Research thread");
});

test("a long backlink excerpt is cut at a word", (t) => {
  t.is(shortExcerpt("alpha beta gamma", 11), "alpha beta…");
  t.is(shortExcerpt("  alpha   beta  "), "alpha beta");
});

const pageResponses = (page: unknown) => ({
  "workspaces.list": [workspace()],
  "settings.get": serverSettings(),
  "research.listTrees": [summary({ workspaceId: WORKSPACE_ID })],
  "folders.get": { folders: [], membership: {}, starred: [], collapsed: [] },
  "feed.recentActivity": activityPage([]),
  "highlights.listFeed": [],
  "documents.list": [],
  "encyclopedia.listPages": [pageSummary()],
  "encyclopedia.getPage": page,
  "encyclopedia.regeneratePage": page,
});

test.serial("a page names its term when the model titled it differently", async (t) => {
  const app = await renderApp("/e/collective-memory?ws=w1", {
    queryClient: testQueryClient(),
    responses: pageResponses(
      encyclopediaPage({ title: "Collective memory (sociology)", term: "Collective memory" }),
    ),
  });

  await waitUntil(
    t,
    () => screen.queryAllByText("Collective memory (sociology)").length > 0,
    "the page renders its own title",
  );
  t.truthy(screen.getByText("Term: Collective memory"));
  app.unmount();
});

test.serial("a failed page shows the error and offers a rewrite", async (t) => {
  const app = await renderApp("/e/collective-memory?ws=w1", {
    queryClient: testQueryClient(),
    responses: pageResponses(
      encyclopediaPage({ status: "failed", error: "the model returned nothing" }),
    ),
  });

  await waitUntil(
    t,
    () => screen.queryAllByText("the model returned nothing").length > 0,
    "the failure is shown",
  );
  fireEvent.click(screen.getByText("Retry"));
  await waitUntil(
    t,
    () => app.trpc.calls.some((call) => call.path === "encyclopedia.regeneratePage"),
    "and Retry asks for the page again",
  );
  t.deepEqual(app.trpc.calls.find((call) => call.path === "encyclopedia.regeneratePage")?.input, {
    workspaceId: WORKSPACE_ID,
    slug: "collective-memory",
  });
  app.unmount();
});

test.serial("the sidebar lists pages alphabetically once one exists", async (t) => {
  const app = await renderApp("/?ws=w1", {
    queryClient: testQueryClient(),
    responses: {
      ...pageResponses(encyclopediaPage()),
      "encyclopedia.listPages": [
        pageSummary({ slug: "zeitgeist", title: "Zeitgeist" }),
        pageSummary({ slug: "amnesia", title: "Amnesia" }),
      ],
    },
  });

  await waitUntil(
    t,
    () => screen.queryAllByText("Encyclopedia").length > 0,
    "the section appears once a page exists",
  );
  const titles = screen
    .getAllByRole("listitem")
    .map((item) => item.textContent?.trim())
    .filter((title): title is string => title === "Amnesia" || title === "Zeitgeist");
  t.deepEqual(titles, ["Amnesia", "Zeitgeist"]);
  const research = screen.getByRole("region", { name: "Research" });
  const encyclopedia = screen.getByRole("region", { name: "Encyclopedia" });
  t.truthy(
    research.compareDocumentPosition(encyclopedia) & Node.DOCUMENT_POSITION_FOLLOWING,
    "the encyclopedia follows Research",
  );
  t.is(encyclopedia.querySelector(":scope > div")?.textContent, "Encyclopedia");
  app.unmount();
});
