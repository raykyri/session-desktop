// Keyboard and motion (02 §10, §12.2 `spaces-keyboard`): focus moving into
// and out of the feed's layers, the Escape order of stacked layers, where
// focus goes when a composer closes, a keyboard selection's actions, the
// composer's menus, the padded scroll, and reduced motion.
//
// The viewer's channel holds hal's post with replies and hal's answered ask
// with its branches, written through the sync routes, and the ask answered
// by the run loop with fixture providers, before the specs run
// (`world.ts`).

import { expect, test, type Page } from "@playwright/test";

import { compose, row, scrollSettled, signInAndOpen, toast } from "./spaces.js";
import { branchedAsk, channelName, person, ulid } from "./world.js";

const LOGIN = "e2e-keyboard";
const POST = "Is anyone else seeing the follow-up count lag";

const w = { own: "", hal: "", post: "", ask: "" };

test.beforeAll(async ({ browser }) => {
  const me = await person(browser, LOGIN);
  const motion = await person(browser, "e2e-motion");
  const hal = await person(browser, "e2e-keyboard-hal");
  w.hal = hal.handle;
  w.own = channelName("keys");
  const own = await me.channel(w.own);
  for (const p of [hal, motion]) await p.join(own);
  // the post with rows above and below it, so the feed scrolls past it
  const fillers = (from: number) =>
    Array.from(
      { length: 6 },
      (_, i) =>
        [
          "threads.create",
          { id: ulid(), space: own, kind: "post", q: `Filler post ${from + i}` },
        ] as const,
    );
  await hal.all(fillers(1));
  w.post = await hal.post(own, `${POST} after a branch is deleted?`);
  await me.reply(w.post, "Same here.");
  await hal.reply(w.post, "Thanks, noted.");
  await hal.all(fillers(7));
  // the newest thread: at the top of the feed
  w.ask = (await branchedAsk(hal, motion, own)).thread;
});

const side = (page: Page) => page.locator(`[data-side="${w.ask}"]`);
const answer = (page: Page) => page.locator(`#pr-${w.ask}`);

/** Selects the whole of a passage of the first ask's answer. */
async function selectPassage(page: Page, passage: number) {
  await answer(page)
    .locator(`[data-passage="${passage}"]`)
    .evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      document.getSelection()?.removeAllRanges();
      document.getSelection()?.addRange(range);
    });
}

/** Scrolls the feed to its top and waits for it to be at rest there. */
async function toTop(page: Page) {
  await page.locator("[data-shell-scroll]").evaluate((el) => {
    el.scrollTo({ top: 0, behavior: "instant" });
  });
  await scrollSettled(page);
  expect(await page.locator("[data-shell-scroll]").evaluate((el) => el.scrollTop)).toBe(0);
}

test.describe("focus and Escape on an ask", () => {
  test.beforeEach(async ({ page }) => {
    await signInAndOpen(page, LOGIN);
  });

  test("a card's controls in order, and each tree is one tab stop", async ({ page }) => {
    const card = page.locator(`#card-${w.ask}`);
    // Each tree has exactly one row in the tab order.
    const stops = await side(page)
      .getByRole("tree")
      .evaluateAll((trees) =>
        trees.map((tree) => tree.querySelectorAll('[role="treeitem"][tabindex="0"]').length),
      );
    expect(stops.length).toBeGreaterThan(1);
    expect(stops).toEqual(stops.map(() => 1));

    await card.getByRole("button", { name: "More" }).focus();
    const visited: { name: string; tree: number }[] = [];
    for (let i = 0; i < 24; i++) {
      await page.keyboard.press("Tab");
      visited.push(
        await page.evaluate(() => {
          const active = document.activeElement;
          const tree = active?.closest('[role="tree"]');
          return {
            name: active?.getAttribute("aria-label") ?? active?.textContent ?? "",
            tree: tree ? [...document.querySelectorAll('[role="tree"]')].indexOf(tree) : -1,
          };
        }),
      );
    }
    const names = visited.map((v) => v.name);
    // Citations and count buttons in reading order, then the footer, then
    // the side column's trees.
    expect(names.slice(0, 3)).toEqual([
      "Source 1",
      "3 branches on this passage. Open the first",
      "Source 1",
    ]);
    const footer = names.indexOf("Ask a follow-up, 4 branches");
    expect(footer).toBeGreaterThan(2);
    expect(names[footer + 1]).toMatch(/^Save/);
    const first = visited.findIndex((v) => v.tree >= 0);
    expect(first).toBeGreaterThan(footer);
    // The stop after a tree's row is outside that tree.
    expect(visited[first + 1]?.tree).not.toBe(visited[first]?.tree);
  });

  test("Escape closes a menu, then the selection actions, then the composer", async ({ page }) => {
    await page
      .locator(`#card-${w.ask}`)
      .getByRole("button", { name: /^Ask a follow-up/ })
      .click();
    const field = side(page).getByRole("textbox", { name: "Ask about the answer" });
    await field.fill("draft");
    // A scroll removes the selection actions; start from a feed at rest at
    // its top, where the composer's menus are in view.
    await toTop(page);
    await selectPassage(page, 2);
    await expect(page.getByRole("button", { name: "Branch here" })).toBeVisible();
    // A menu elsewhere, opened from the keyboard.
    await page.getByTitle("Model and effort").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Branch here" })).toBeVisible();
    await field.focus();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Branch here" })).toHaveCount(0);
    await expect(field).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(field).toHaveCount(0);
  });

  test("Escape on a composer returns focus to the selected row", async ({ page }) => {
    const row = side(page).getByRole("treeitem", { name: /how does the darknet/ });
    await row.click();
    await side(page).getByRole("button", { name: "Continue" }).click();
    await expect(side(page).getByRole("textbox", { name: "Continue ask" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(row).toBeFocused();
  });

  test("Close on a composer returns focus to the selected row", async ({ page }) => {
    const row = side(page).getByRole("treeitem", { name: /how does the darknet/ });
    await row.click();
    await side(page).getByRole("button", { name: "Continue" }).click();
    await side(page).getByRole("button", { name: "Close", exact: true }).click();
    await expect(row).toBeFocused();
  });

  test("a send moves focus to the new row", async ({ page }) => {
    await side(page)
      .getByRole("treeitem", { name: /how does the darknet/ })
      .click();
    await side(page).getByRole("button", { name: "Continue" }).click();
    const field = side(page).getByRole("textbox", { name: "Continue ask" });
    await field.fill("a follow-up to send");
    await field.press("Control+Enter");
    await expect(side(page).getByRole("treeitem", { name: /a follow-up to send/ })).toBeFocused();
  });

  test("deleting a branch moves focus to the next row", async ({ page }) => {
    await side(page)
      .getByRole("treeitem", { name: /how does the darknet/ })
      .click();
    await side(page).getByRole("button", { name: "Continue" }).click();
    const field = side(page).getByRole("textbox", { name: "Continue ask" });
    await field.fill("a branch to delete");
    await field.press("Control+Enter");
    const added = side(page).getByRole("treeitem", { name: /a branch to delete/ });
    await expect(side(page).locator(".preview")).toContainText("Bloom filters answer set", {
      timeout: 30_000,
    });
    await side(page).locator(".preview").getByRole("button", { name: "More" }).click();
    await page.getByRole("menuitem", { name: "Delete branch" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
    await expect(added).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const active = document.activeElement;
          return active?.getAttribute("role") === "treeitem" && active.closest("[data-side]")
            ? "a tree row"
            : (active?.tagName ?? "none");
        }),
      )
      .toBe("a tree row");
  });

  test("the quoted composer closes on Escape and returns focus", async ({ page }) => {
    await toTop(page);
    await selectPassage(page, 2);
    await page.getByRole("button", { name: "Branch here" }).click();
    const field = side(page).getByRole("textbox", { name: "Ask about this passage" });
    await expect(field).toBeFocused();
    // The quote's Close is the only one: the composer shows none of its own.
    await expect(side(page).getByRole("button", { name: "Close", exact: true })).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(field).toHaveCount(0);
    await expect(
      page.locator(`#card-${w.ask}`).getByRole("button", { name: /^Ask a follow-up/ }),
    ).toBeFocused();
  });

  test("a selection made with Shift+Arrow shows actions reachable by Tab", async ({ page }) => {
    await toTop(page);
    // Focus in the card, and the passage's first character selected; then
    // the keyboard extends the selection.
    await page.locator(`#card-${w.ask}`).focus();
    await answer(page)
      .locator('[data-passage="2"]')
      .evaluate((el) => {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        const text = walker.nextNode();
        if (!text) return;
        const range = document.createRange();
        range.setStart(text, 0);
        range.setEnd(text, 1);
        document.getSelection()?.removeAllRanges();
        document.getSelection()?.addRange(range);
      });
    for (let i = 0; i < 10; i++) await page.keyboard.press("Shift+ArrowRight");
    expect(await page.evaluate(() => document.getSelection()?.toString().length)).toBe(11);
    const branchHere = page.getByRole("button", { name: "Branch here" });
    await expect(branchHere).toBeVisible();
    // Tab from the card goes to the actions first.
    const actions = page.getByRole("group", { name: "Selected text" }).getByRole("button");
    await page.keyboard.press("Tab");
    await expect(actions.first()).toBeFocused();
    if ((await actions.count()) > 1) await page.keyboard.press("Tab");
    await expect(branchHere).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(side(page).getByRole("textbox", { name: "Ask about this passage" })).toBeFocused();
  });
});

test.describe("focus and Escape", () => {
  test.beforeEach(async ({ page }) => {
    await signInAndOpen(page, LOGIN);
  });

  test("Escape closes the About editor, then the info dialog", async ({ page }) => {
    await page.goto(`/c/${w.own}`);
    await page.getByRole("button", { name: "About this channel" }).click();
    await page.getByRole("button", { name: "Edit" }).click();
    await expect(page.getByRole("dialog", { name: `Edit #${w.own}` })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: `Edit #${w.own}` })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Edit" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: `#${w.own}` })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "About this channel" })).toBeFocused();
  });

  test("the delete confirmation starts on Cancel and returns to More", async ({ page }) => {
    await compose(page, "To be deleted.", "Post");
    const more = page.locator(".tcard").first().getByRole("button", { name: "More" });
    await more.click();
    await page.getByRole("menuitem", { name: "Delete post" }).click();
    await expect(page.getByRole("button", { name: "Cancel" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await expect(more).toBeFocused();
  });

  test("the model menu steps the effort down; menus return focus to the field", async ({
    page,
  }) => {
    const field = page.getByRole("textbox", { name: "Ask or post" });
    const picker = page.getByTitle("Model and effort");
    const effort = page.getByRole("menuitem", { name: /^Effort/ });
    // The composer starts on the site defaults (`models.list`); Fable is the
    // model that accepts Max.
    await picker.click();
    await page.getByRole("menuitemradio", { name: "Claude Fable 5.1" }).click();
    await expect(field).toBeFocused();
    await picker.click();
    await effort.click();
    await page
      .getByRole("menu", { name: "Effort" })
      .getByRole("menuitemradio", { name: "Max" })
      .click();
    await expect(field).toBeFocused();
    await picker.click();
    await expect(effort).toContainText("Max");
    await page.getByRole("menuitemradio", { name: "Gemini 3.8 Flash" }).click();
    await expect(field).toBeFocused();
    await picker.click();
    // Gemini accepts up to High.
    await expect(effort).toContainText("High");
    await page.keyboard.press("Escape");
    await expect(field).toBeFocused();

    // The mode menu from the keyboard.
    await page.getByRole("button", { name: "Ask or post" }).focus();
    await page.keyboard.press("Enter");
    await page.getByRole("menuitemradio", { name: /^Post/ }).press("Enter");
    await expect(field).toBeFocused();
    await expect(field).toHaveAttribute("placeholder", "Write a post");
  });

  test("a composer opened near the bottom is scrolled in with 24 px below it", async ({ page }) => {
    const post = row(page, POST);
    const replyAtRoot = post.getByRole("button", { name: "Reply at root" });
    // "Reply at root" 10 px above the scroll container's bottom: the
    // composer opens under it, out of view.
    await replyAtRoot.evaluate((el) => {
      const scroller = el.closest<HTMLElement>("[data-shell-scroll]");
      if (!scroller) return;
      const bottom = el.getBoundingClientRect().bottom;
      scroller.scrollBy({
        top: bottom - scroller.getBoundingClientRect().bottom + 10,
        behavior: "instant",
      });
    });
    await scrollSettled(page);
    // A click without Playwright's own scroll into view.
    await replyAtRoot.evaluate((el: HTMLElement) => el.click());
    const field = post.getByRole("textbox", { name: `Reply to @${w.hal}` });
    await expect(field).toBeFocused();
    await scrollSettled(page);
    const below = await field.evaluate((el) => {
      const form = el.closest("form") ?? el;
      const scroller = el.closest("[data-shell-scroll]");
      return (scroller?.getBoundingClientRect().bottom ?? 0) - form.getBoundingClientRect().bottom;
    });
    expect(below).toBeGreaterThanOrEqual(23);
    expect(below).toBeLessThanOrEqual(25);
  });
});

test.describe("reduced motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("no transitions, pulses or fades, and instant scrolls", async ({ page }) => {
    // Records the `behavior` of every scroll the page asks for.
    await page.addInitScript(() => {
      const seen: string[] = [];
      (window as unknown as { scrollBehaviours: string[] }).scrollBehaviours = seen;
      for (const name of ["scrollBy", "scrollTo", "scrollIntoView"] as const) {
        const original: (...args: never[]) => void = Reflect.get(Element.prototype, name);
        Reflect.set(Element.prototype, name, function (this: Element, ...args: unknown[]) {
          const options = args[0];
          if (options && typeof options === "object" && "behavior" in options)
            seen.push(String(options.behavior));
          Reflect.apply(original, this, args);
        });
      }
    });
    await signInAndOpen(page, "e2e-motion");
    const duration = await page
      .locator(".app-bar-slot")
      .evaluate((el) => parseFloat(getComputedStyle(el).transitionDuration));
    expect(duration).toBeLessThan(0.001);

    const behaviours = () =>
      page.evaluate(() => (window as unknown as { scrollBehaviours: string[] }).scrollBehaviours);
    // A reply's card fades in without animation.
    const post = row(page, POST);
    await post.getByRole("treeitem", { name: /Thanks, noted/ }).click();
    const preview = post.locator(".preview.fadein");
    await expect(preview).toBeVisible();
    expect(await preview.evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
    expect((await behaviours()).filter((b) => b === "smooth")).toEqual([]);

    await page.locator(`#card-${w.post}`).getByRole("button", { name: /^Save/ }).click();
    await expect(toast(page)).toBeVisible();
    expect(await toast(page).evaluate((el) => getComputedStyle(el).animationName)).toBe("none");

    // a run paced over seconds, so its status is on screen to read
    await compose(page, "fixture:paced-answer a question that runs");
    const status = page.locator(".tcard").first().locator(".status");
    await expect(status).toBeVisible();
    await expect
      .poll(() => status.evaluate((el) => getComputedStyle(el, "::before").animationName))
      .toBe("none");

    // A thread address scrolls to its thread at once.
    await page.goto(`/c/${w.own}?t=${w.post}`);
    await expect(page.locator(`#card-${w.post}`)).toBeInViewport();
    await expect.poll(async () => (await behaviours()).length).toBeGreaterThan(0);
    expect((await behaviours()).filter((b) => b === "smooth")).toEqual([]);
  });
});
