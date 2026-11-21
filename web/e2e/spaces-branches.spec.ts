// Branches end to end (02 §12.2 `spaces-branches`; skipped until M5a's run
// loop answers asks): a passage's count button, the
// selected branch's card, Continue, Branch, the footer's follow-up, Comment,
// Branch here and Look up over a selection, Open as its own thread, the
// card's fade on a newly shown item only, and the rail's dots on their rows'
// first lines.

import { expect, test, type Page } from "@playwright/test";

import { FIRST_ASK, flushRuns, holdRuns } from "./fixtureWorld.js";
import { NO_RUNS, scrollSettled, signInAndOpen, toast } from "./spaces.js";

// The branches of an ask need its answer, and runs are answered from M5a:
// until then this spec reads the fixture replica's asks, which the suite's
// build does not load.
test.skip(true, NO_RUNS);

const side = (page: Page) => page.locator(`[data-side="${FIRST_ASK}"]`);
const answer = (page: Page) => page.locator(`#pr-${FIRST_ASK}`);

test.beforeEach(async ({ page }) => {
  await signInAndOpen(page, "e2e-branches");
});

test("a passage's count button opens its first branch", async ({ page }) => {
  await answer(page)
    .getByRole("button", { name: "3 branches on this passage. Open the first" })
    .click();
  const selected = side(page).getByRole("treeitem", { selected: true });
  await expect(selected).toContainText("which of these actually let you trade");
  await expect(selected).toBeFocused();
  await expect(side(page).locator(".preview")).toContainText(
    "Few of these works go past visibility",
  );
  await expect(side(page).getByRole("button", { name: "Continue" })).toBeVisible();
  await expect(side(page).getByRole("button", { name: "Branch", exact: true })).toBeVisible();
});

test("Continue asks under the branch and the new row is selected and answered", async ({
  page,
}) => {
  await holdRuns(page, "running");
  await side(page)
    .getByRole("treeitem", { name: /how does the darknet/ })
    .click();
  await side(page).getByRole("button", { name: "Continue" }).click();
  const field = side(page).getByRole("textbox", { name: "Continue ask" });
  await expect(field).toBeFocused();
  await field.fill("is the ranking public");
  await field.press("Control+Enter");
  const row = side(page).getByRole("treeitem", { name: /is the ranking public/ });
  await expect(row).toHaveAttribute("aria-selected", "true");
  await expect(row).toHaveAttribute("aria-level", "3");
  await expect(side(page).getByText("Researching · Step 1 of 4")).toBeVisible();
  await flushRuns(page);
  await expect(side(page).getByText(/^Mock answer\. In the app/)).toBeVisible();
  await expect(
    page.locator(`#card-${FIRST_ASK}`).getByRole("button", { name: /^Ask a follow-up, 7/ }),
  ).toBeVisible();
});

test("Branch asks beside the branch", async ({ page }) => {
  await side(page)
    .getByRole("treeitem", { name: /how does the darknet/ })
    .click();
  await side(page).getByRole("button", { name: "Branch", exact: true }).click();
  const field = side(page).getByRole("textbox", { name: "Ask beside this" });
  await field.fill("what about cory doctorow");
  await side(page).getByRole("button", { name: "Ask", exact: true }).click();
  // Beside: a child of the branch's parent, at the same level.
  await expect(
    side(page).getByRole("treeitem", { name: /what about cory doctorow/ }),
  ).toHaveAttribute("aria-level", "2");
});

test("the footer's follow-up opens the answer's composer; Comment replaces it", async ({
  page,
}) => {
  const thread = page.locator(`#card-${FIRST_ASK}`);
  await thread.getByRole("button", { name: /^Ask a follow-up/ }).click();
  await expect(side(page).getByRole("textbox", { name: "Ask about the answer" })).toBeFocused();
  await expect(thread.getByRole("button", { name: /^Ask a follow-up/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  // The button again with an empty field closes it.
  await thread.getByRole("button", { name: /^Ask a follow-up/ }).click();
  await expect(side(page).getByRole("textbox", { name: "Ask about the answer" })).toHaveCount(0);

  await side(page)
    .getByRole("treeitem", { name: /how does the darknet/ })
    .click();
  await side(page).getByRole("button", { name: "Continue" }).click();
  await expect(side(page).getByRole("textbox", { name: "Continue ask" })).toBeVisible();
  await side(page).getByRole("button", { name: "Comment" }).click();
  await expect(side(page).getByRole("textbox", { name: "Continue ask" })).toHaveCount(0);
  const comment = side(page).getByRole("textbox", { name: "Comment here" });
  await comment.fill("Worth adding the sequel. @hal_b");
  await side(page).getByRole("button", { name: "Comment", exact: true }).last().click();
  await expect(side(page).getByText("1 comment")).toBeVisible();
  await expect(toast(page)).toHaveText("Notified @hal_b.");
});

/** Drags across the first `words` words of a passage of the answer. */
async function selectWords(page: Page, passage: number, words: number) {
  const box = await answer(page)
    .locator(`[data-passage="${passage}"]`)
    .evaluate((el, n) => {
      const text = el.firstChild as Text;
      const range = document.createRange();
      const ends = [...text.data.matchAll(/\S+/g)].slice(0, n);
      const last = ends[ends.length - 1];
      range.setStart(text, 0);
      range.setEnd(text, (last?.index ?? 0) + (last?.[0].length ?? 0));
      const sel = document.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      const r = range.getBoundingClientRect();
      return { x: r.right, y: r.bottom };
    }, words);
  // The actions follow the selection (mouseup or selectionchange).
  await page.mouse.move(box.x, box.y);
  await page.mouse.up();
}

test("Look up over two words writes a look-up under the answer and selects it", async ({
  page,
}) => {
  await selectWords(page, 0, 2);
  await page.getByRole("button", { name: "Look up" }).click();
  const row = side(page).getByRole("treeitem", { selected: true });
  await expect(row).toContainText("Science fiction");
  await expect(row.getByTitle("Look up")).toBeVisible();
  await expect(side(page).locator(".lookh")).toContainText("Look upScience fiction");
  await expect(side(page).getByText(/Science fiction\*?\*?: mock description/)).toBeVisible({
    timeout: 10_000,
  });
});

test("Branch here quotes the selection in the answer's composer", async ({ page }) => {
  await selectWords(page, 2, 6);
  await expect(page.getByRole("button", { name: "Look up" })).toHaveCount(0);
  await page.getByRole("button", { name: "Branch here" }).click();
  const field = side(page).getByRole("textbox", { name: "Ask about this passage" });
  await expect(field).toBeFocused();
  await expect(side(page).locator(".bq")).toContainText("In these systems, a public score");
  await expect(answer(page).locator(".qsel")).toHaveAttribute("data-passage", "2");
});

test("each dot sits on its row's first line, also when the row wraps", async ({ page }) => {
  await side(page)
    .getByRole("treeitem", { name: /how does the darknet/ })
    .click();
  // The tree that holds the selected row.
  const graph = side(page)
    .locator(".graph")
    .filter({ has: page.getByRole("treeitem", { selected: true }) });
  await expect(graph).toHaveCount(1);
  const offsets = await graph.evaluate((graph) => {
    const dots = [...graph.querySelectorAll("circle")];
    const rows = [...graph.querySelectorAll<HTMLElement>(".grow-r")];
    const top = graph.getBoundingClientRect().top;
    return rows.map((row, i) => {
      const line = row.querySelector<HTMLElement>(".gq");
      const lh = parseFloat(getComputedStyle(line ?? row).lineHeight);
      const first = (line ?? row).getBoundingClientRect().top - top + lh / 2;
      return Math.abs(Number(dots[i]?.getAttribute("cy")) - first);
    });
  });
  for (const offset of offsets) expect(offset).toBeLessThanOrEqual(1);
});

test("the card fades in for a newly shown item, not when it mounts again", async ({ page }) => {
  const darknet = side(page).getByRole("treeitem", { name: /how does the darknet/ });
  await darknet.click();
  await expect(side(page).locator(".preview")).toHaveClass(/fadein/);
  // Away and back by the bar: the same item, mounted again, does not fade.
  await page.getByRole("banner").getByRole("link", { name: "#public" }).click();
  await expect(page).toHaveURL(/\/c\/public$/);
  await page.getByRole("banner").getByRole("link", { name: "Session home" }).click();
  await expect(darknet).toHaveAttribute("aria-selected", "true");
  await expect(side(page).locator(".preview")).not.toHaveClass(/fadein/);
});

test("Open as its own thread scrolls to the new thread", async ({ page }) => {
  await side(page)
    .getByRole("treeitem", { name: /how does the darknet/ })
    .click();
  await side(page).locator(".preview").getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Open as its own thread" }).click();
  const promoted = page.locator(".tcard").first();
  await expect(promoted.locator(".tt-title")).toContainText(/darknet/i);
  await scrollSettled(page);
  await expect(promoted).toBeInViewport();
  // The branch keeps Comment beside Open thread.
  await expect(side(page).getByRole("button", { name: "Comment" })).toBeVisible();
});
