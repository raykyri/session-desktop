// The app shell end to end (02 §2.2, W2.2, W2.3, W2.7; 05 M4): where the app
// bar sits per layout and width band, the bar hiding on scroll without moving
// the page, the site footer on feeds and pages, the signed-out bar, and the
// tab's client id across a reload and in a duplicated tab (01 Y3).
//
// The feeds are a channel of olga's that the viewer joined, with posts
// written through the sync routes before the specs run (`world.ts`).

import { expect, test, type Page } from "@playwright/test";

import { APP_ORIGIN } from "./constants.js";
import { signIn } from "./helpers.js";
import { channelName, person, ulid } from "./world.js";

const LOGIN = "e2e-shell";
const lounge = { name: "", id: "" };
const lab = { name: "" };

test.beforeAll(async ({ browser }) => {
  const olga = await person(browser, "e2e-shell-olga");
  const me = await person(browser, LOGIN);
  lounge.name = channelName("shell");
  lounge.id = await olga.channel(lounge.name);
  lab.name = channelName("shell-lab");
  await olga.channel(lab.name, { vis: "private" });
  await me.join(lounge.id);
  // enough rows to scroll the feed
  await olga.all(
    Array.from(
      { length: 16 },
      (_, i) =>
        [
          "threads.create",
          { id: ulid(), space: lounge.id, kind: "post", q: `Shell post ${i + 1}` },
        ] as const,
    ),
  );
});

/** The abuse mailbox of the origin the client was built for (`SESSION_PUBLIC_ORIGIN`
 * in `playwright.config.ts`). */
const ABUSE_ADDRESS = `abuse@${new URL(APP_ORIGIN).hostname}`;

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** The boxes the placement rules compare: the bar, the shell, and the main
 * and side cells of the first feed row. */
async function shellBoxes(page: Page) {
  return page.evaluate(() => {
    const box = (element: Element | null): Box | null => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    };
    const row = document.querySelector(".feed-row");
    return {
      bar: box(document.querySelector(".app-bar-slot")),
      shell: box(document.querySelector(".app-shell")),
      main: box(row?.firstElementChild ?? null),
      side: box(row?.firstElementChild?.nextElementSibling ?? null),
    };
  });
}

type Boxes = Awaited<ReturnType<typeof shellBoxes>>;

/**
 * Waits until the bar's left and right edges are `expected`'s, within half a
 * pixel (the columns are centred and can sit on a half pixel). The bar
 * re-measures one frame after a resize or a layout change.
 */
async function expectBarEdges(
  page: Page,
  expected: (boxes: Boxes) => [number, number],
  message: string,
) {
  await expect
    .poll(
      async () => {
        const boxes = await shellBoxes(page);
        const [left, right] = expected(boxes);
        if (!boxes.bar) return "no bar";
        return [boxes.bar.left - left, boxes.bar.right - right].map((d) =>
          Math.abs(d) <= 0.5 ? 0 : d,
        );
      },
      { message },
    )
    .toEqual([0, 0]);
}

const mainColumn = ({ main }: Boxes): [number, number] => [main?.left ?? NaN, main?.right ?? NaN];
const bothColumns = ({ main, side }: Boxes): [number, number] => [
  main?.left ?? NaN,
  side?.right ?? NaN,
];
const fullWidth = (width: number) => (): [number, number] => [0, width];

/** Home, a channel, Browse and Usage, with the heading of each page; a feed
 * (null) shows its threads. */
const screens = (): [string, string | null][] => [
  ["/", null],
  [`/c/${lounge.name}`, null],
  ["/browse", "Browse channels"],
  ["/usage", "Usage and API keys"],
];

/** The screen at `path` rendered, rather than a redirect. */
async function expectScreen(page: Page, path: string, heading: string | null) {
  await expect(page, path).toHaveURL(`${APP_ORIGIN}${path}`);
  if (heading === null) {
    await expect(page.locator(".tcard").first(), path).toBeVisible();
  } else {
    await expect(page.getByRole("heading", { name: heading, level: 2 }), path).toBeVisible();
  }
}

async function openHome(page: Page) {
  await page.goto("/");
  await expect(page.locator(".tcard").first()).toBeVisible();
}

test.describe("signed in", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, { login: LOGIN });
  });

  test("the bar's placement per layout and width", async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await openHome(page);
    const toggle = (name: "Expand" | "Collapse") => page.getByRole("button", { name, exact: true });
    await expect(toggle("Expand")).toBeVisible();

    // Centred above 1320 px: a floating card with the main column's left edge
    // and width (600 px), at the top.
    await expectBarEdges(page, mainColumn, "centred at 1600");
    const centred = await shellBoxes(page);
    expect(Math.round((centred.bar?.right ?? 0) - (centred.bar?.left ?? 0))).toBe(600);
    expect(centred.bar?.top).toBe(0);
    await expect(page.locator(".app-shell")).toHaveAttribute("data-bar-aligned", "");
    // The card's narrower insets (`#shell.colbar .appbar`).
    const header = page.locator("header.app-bar");
    await expect(header).toHaveCSS("padding-left", "10px");
    await expect(header).toHaveCSS("padding-right", "8px");
    await expect(header).toHaveCSS("border-left-width", "1px");

    // Centred from 861 to 1320 px: from the main column's left edge to the
    // side column's right edge.
    await page.setViewportSize({ width: 1150, height: 900 });
    await expectBarEdges(page, bothColumns, "centred at 1150");
    const pair = await shellBoxes(page);
    expect(Math.round((pair.bar?.right ?? 0) - (pair.bar?.left ?? 0))).toBe(600 + 21 + 330);

    // 860 px and below: full width.
    await page.setViewportSize({ width: 600, height: 900 });
    await expectBarEdges(page, fullWidth(600), "centred at 600");
    await expect(page.locator(".app-shell")).not.toHaveAttribute("data-bar-aligned");

    // Wide: full width at every width.
    await toggle("Expand").click();
    await expect(toggle("Collapse")).toBeVisible();
    for (const width of [600, 1150, 1600]) {
      await page.setViewportSize({ width, height: 900 });
      await expectBarEdges(page, fullWidth(width), `wide at ${width}`);
    }
    // Full width: the bar's own insets and only a bottom border.
    await expect(header).toHaveCSS("padding-left", "16px");
    await expect(header).toHaveCSS("padding-right", "14px");
    await expect(header).toHaveCSS("border-left-width", "0px");

    // Back to centred: the floating card again.
    await toggle("Collapse").click();
    await expectBarEdges(page, mainColumn, "centred again at 1600");
  });

  test("the bar hides on scroll down and returns on scroll up without moving the page", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await openHome(page);
    const scroller = page.locator("[data-shell-scroll]");
    const slot = page.locator(".app-bar-slot");

    /** The first row's top in the viewport, the scroll offset, and their
     * sum, which is the row's place in the scrolled content. */
    const place = () =>
      page.evaluate(() => {
        const scroll = document.querySelector<HTMLElement>("[data-shell-scroll]");
        const row = document.querySelector(".feed-row");
        const top = row?.getBoundingClientRect().top ?? Number.NaN;
        const scrollTop = scroll?.scrollTop ?? Number.NaN;
        return { top, scrollTop, offset: top + scrollTop };
      });
    /** Waits until the scroll offset has stopped changing. */
    const settled = async () => {
      let previous = -1;
      await expect
        .poll(async () => {
          const { scrollTop } = await place();
          const still = scrollTop === previous;
          previous = scrollTop;
          return still;
        })
        .toBe(true);
    };
    const barTop = async () => (await slot.boundingBox())?.y ?? Number.NaN;

    const start = await place();
    expect(start.scrollTop).toBe(0);
    await expect(slot).not.toHaveAttribute("data-hidden");

    const box = await scroller.boundingBox();
    if (!box) throw new Error("the scroll container has no box");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

    // Down 400 px: the bar slides up out of view.
    await page.mouse.wheel(0, 400);
    await settled();
    await expect(slot).toHaveAttribute("data-hidden", "");
    const hidden = await slot.boundingBox();
    await expect.poll(async () => (await slot.boundingBox())?.y).toBe(-(hidden?.height ?? 0));
    const down = await place();
    expect(down.scrollTop).toBeGreaterThan(48);
    expect(down.offset).toBeCloseTo(start.offset, 0);
    // Once the slide has finished, the page is where the scroll left it.
    await page.waitForTimeout(300);
    expect(await place()).toEqual(down);

    // Up 50 px: the bar returns.
    await page.mouse.wheel(0, -50);
    await settled();
    await expect(slot).not.toHaveAttribute("data-hidden");
    await expect.poll(barTop).toBe(0);
    const up = await place();
    expect(up.scrollTop).toBeLessThan(down.scrollTop);
    expect(up.scrollTop).toBeGreaterThan(48);
    expect(up.offset).toBeCloseTo(start.offset, 0);
    await page.waitForTimeout(300);
    expect(await place()).toEqual(up);
  });

  test("the site footer ends every feed and page", async ({ page }) => {
    for (const [path, screen] of screens()) {
      await page.goto(path);
      await expectScreen(page, path, screen);
      await expectSiteFooter(page, path);
    }
  });

  test("a reload keeps the tab's client id; a duplicated tab registers a new one", async ({
    page,
    context,
  }) => {
    const registers: { sent: { clientId?: string }; answer: Record<string, unknown> }[] = [];
    const watch = (p: Page) =>
      p.on("response", async (res) => {
        if (!res.url().endsWith("/api/sync/register")) return;
        registers.push({
          sent: (res.request().postDataJSON() ?? {}) as { clientId?: string },
          answer: (await res.json()) as Record<string, unknown>,
        });
      });
    watch(page);
    await openHome(page);
    await expect.poll(() => registers.length).toBe(1);
    const first = registers[0];
    expect(first?.sent.clientId).toBeUndefined();
    expect(first?.answer).toMatchObject({ ok: true, reattached: false });
    const id = first?.answer["clientId"];

    // A reload re-attaches the stored id.
    await page.reload();
    await expect(page.locator(".tcard").first()).toBeVisible();
    await expect.poll(() => registers.length).toBe(2);
    expect(registers[1]?.sent.clientId).toBe(id);
    expect(registers[1]?.answer).toMatchObject({ ok: true, clientId: id, reattached: true });

    // A duplicated tab inherits a copy of sessionStorage; the first tab holds
    // the id's Web Lock, so the copy registers a new id.
    const stored = await page.evaluate(() => sessionStorage.getItem("session-client"));
    expect(stored).toContain(String(id));
    const tab = await context.newPage();
    watch(tab);
    await tab.addInitScript((value) => {
      if (value && !sessionStorage.getItem("session-client"))
        sessionStorage.setItem("session-client", value);
    }, stored);
    await openHome(tab);
    await expect.poll(() => registers.length).toBe(3);
    expect(registers[2]?.sent.clientId).toBeUndefined();
    expect(registers[2]?.answer).toMatchObject({ ok: true, reattached: false });
    expect(registers[2]?.answer["clientId"]).not.toBe(id);
    await tab.close();
  });

  test("a member's bar", async ({ page }) => {
    await openHome(page);
    const bar = page.getByRole("banner");
    await expect(bar.getByRole("link", { name: "Session home" })).toBeVisible();
    await expect(bar.getByRole("button", { name: "Joined", exact: false })).toBeVisible();
    await expect(bar.getByRole("link", { name: /included tokens left/ })).toBeVisible();
    await expect(bar.getByRole("link", { name: /^Saved/ })).toBeVisible();
    await expect(bar.getByRole("button", { name: "Expand" })).toBeVisible();
    await expect(bar.getByRole("button", { name: /^Account/ })).toBeVisible();
    await expect(bar.getByRole("button", { name: "Sign in" })).toHaveCount(0);
  });
});

test.describe("signed out", () => {
  test("the bar has the name, the strip, Join with invite and Sign in", async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await openHome(page);
    const bar = page.getByRole("banner");
    await expect(bar.getByRole("link", { name: "Session home" })).toBeVisible();
    // Signed out, the strip lists the open channels.
    await expect(bar.getByRole("link", { name: `#${lounge.name}` })).toBeVisible();
    await expect(bar.getByRole("link", { name: `#${lab.name}` })).toHaveCount(0);
    await expect(bar.getByRole("button", { name: "Join with invite" })).toBeVisible();
    await expect(bar.getByRole("button", { name: "Sign in" })).toBeVisible();
    // One scope signed out, so no picker; no ring, Saved, layout toggle or
    // account menu.
    await expect(bar.getByRole("button", { name: "Joined" })).toHaveCount(0);
    await expect(bar.getByRole("link", { name: /included tokens left/ })).toHaveCount(0);
    await expect(bar.getByRole("link", { name: /^Saved/ })).toHaveCount(0);
    await expect(bar.getByRole("button", { name: /^(Expand|Collapse)$/ })).toHaveCount(0);
    await expect(bar.getByRole("button", { name: /^Account/ })).toHaveCount(0);

    // Accent-filled with white text, as the mockup's primary buttons.
    const signIn = bar.getByRole("button", { name: "Sign in" });
    await expect(signIn).toHaveCSS("color", "rgb(255, 255, 255)");

    // Sign in opens the auth dialog over the page (02 W7.2).
    await signIn.click();
    const dialog = page.getByRole("dialog", { name: "Sign in to Session" });
    await expect(dialog.getByRole("button", { name: "Sign in with GitHub" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Sign in with X" })).toBeVisible();
    await expect(page).toHaveURL(/\/$/);
  });

  test("the site footer ends the feeds and Browse", async ({ page }) => {
    // Usage needs an account: signed out it goes to the sign-in page.
    for (const [path, screen] of screens().filter(([target]) => target !== "/usage")) {
      await page.goto(path);
      await expectScreen(page, path, screen);
      await expectSiteFooter(page, path);
    }
  });
});

/** "Session · Report abuse: abuse@<host>" with a mailto link, as the last
 * thing in the screen's column. */
async function expectSiteFooter(page: Page, path: string) {
  const footer = page.getByRole("contentinfo");
  await expect(footer, path).toHaveText(`Session · Report abuse: ${ABUSE_ADDRESS}`);
  await expect(footer.getByRole("link", { name: ABUSE_ADDRESS }), path).toHaveAttribute(
    "href",
    `mailto:${ABUSE_ADDRESS}`,
  );
  expect(
    await footer.evaluate((element) => element.parentElement?.lastElementChild === element),
    `${path}: the footer ends the column`,
  ).toBe(true);
}
