// The app shell end to end (02 §2.2, W2.2, W2.3, W2.7; 05 M4): the app bar
// spanning the window in both layouts and at every width, the bar hiding on
// scroll without moving the page, the site footer on feeds and pages, the
// signed-out bar, and the tab's client id across a reload and in a
// duplicated tab (01 Y3).
//
// The feeds are a channel of olga's that the viewer joined, with posts
// written through the sync routes before the specs run (`world.ts`).

import { expect, test, type Page } from "@playwright/test";

import { APP_ORIGIN } from "./constants.js";
import { signIn } from "./helpers.js";
import { channelName, person, ulid } from "./world.js";

const LOGIN = "e2e-shell";
/** A member of many channels, so the strip scrolls at narrow widths. */
const STRIP_LOGIN = "e2e-shell-strip";
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
  const many = await person(browser, STRIP_LOGIN);
  await many.join(lounge.id);
  for (let i = 1; i <= 8; i++) {
    await many.join(await olga.channel(channelName(`shell-strip-${i}`)));
  }
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

/** The boxes the placement checks read: the bar, the shell, and the main and
 * side cells of the first feed row. */
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
 * pixel: a resize or a layout change reaches the layout a frame later.
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

  test("the bar spans the window in both layouts and at every width", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openHome(page);
    const toggle = (name: "Expand" | "Collapse") => page.getByRole("button", { name, exact: true });
    await expect(toggle("Expand")).toBeVisible();
    const header = page.locator("header.app-bar");
    /** The bar's insets, borders and corners: the same in every layout. */
    const expectFullWidthStyle = async (message: string) => {
      expect(
        await header.evaluate((el) => {
          const style = getComputedStyle(el);
          return {
            padding: [style.paddingLeft, style.paddingRight],
            gap: style.columnGap,
            borders: [
              style.borderTopWidth,
              style.borderRightWidth,
              style.borderBottomWidth,
              style.borderLeftWidth,
            ],
            radius: style.borderRadius,
          };
        }),
        message,
      ).toEqual({
        padding: ["16px", "14px"],
        gap: "12px",
        borders: ["0px", "0px", "1px", "0px"],
        radius: "0px",
      });
    };

    // Centred at 1440 px: the bar's box is the viewport's width, at the top,
    // with no rounded corners.
    await expectBarEdges(page, fullWidth(1440), "centred at 1440");
    const centred = await shellBoxes(page);
    expect(centred.bar?.top).toBe(0);
    expect(Math.round((centred.bar?.right ?? 0) - (centred.bar?.left ?? 0))).toBe(1440);
    // the feed's main column is narrower than the bar
    expect((centred.main?.right ?? 0) - (centred.main?.left ?? 0)).toBeLessThan(1440);
    await expectFullWidthStyle("centred at 1440");
    for (const width of [1150, 600]) {
      await page.setViewportSize({ width, height: 900 });
      await expectBarEdges(page, fullWidth(width), `centred at ${width}`);
    }

    // Wide: the same at every width.
    await toggle("Expand").click();
    await expect(toggle("Collapse")).toBeVisible();
    for (const width of [600, 1150, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await expectBarEdges(page, fullWidth(width), `wide at ${width}`);
    }
    await expectFullWidthStyle("wide at 1440");
    await toggle("Collapse").click();
    await expect(toggle("Expand")).toBeVisible();
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

test.describe("narrow widths", () => {
  test("the current chip is scrolled into the strip", async ({ page }) => {
    await signIn(page, { login: STRIP_LOGIN });
    await page.setViewportSize({ width: 1280, height: 900 });
    await openHome(page);
    const strip = page.locator(".channel-strip");
    const names = await strip.getByRole("link").allTextContents();
    expect(names.length).toBeGreaterThanOrEqual(9);
    const last = (names.at(-1) ?? "").replace(/^#/, "");
    for (const width of [700, 600, 520]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/c/${last}`);
      const chip = strip.locator('[aria-current="page"]');
      await expect(chip).toHaveText(`#${last}`);
      // The chip lies inside the strip's box once the scroll has settled.
      await expect
        .poll(
          () =>
            chip.evaluate((el) => {
              const own = el.getBoundingClientRect();
              const box = el.closest(".channel-strip")?.getBoundingClientRect();
              if (!box) return "no strip";
              return own.left >= box.left - 0.5 && own.right <= box.right + 0.5
                ? "inside"
                : `chip ${own.left}-${own.right}, strip ${box.left}-${box.right}`;
            }),
          { message: `at ${width} px` },
        )
        .toBe("inside");
    }
  });

  test("the breakpoints include their own width", async ({ page }) => {
    await signIn(page, { login: LOGIN });
    const brand = page.getByRole("link", { name: "Session home" }).locator("b");
    const ring = page.getByRole("link", { name: /included tokens left/ });
    await page.setViewportSize({ width: 1280, height: 900 });
    await openHome(page);
    // 520 px is a phone width, as the composer's `max-width: 520px` rule
    // has it: only the mark shows.
    await page.setViewportSize({ width: 520, height: 900 });
    await expect(brand).toBeHidden();
    await page.setViewportSize({ width: 521, height: 900 });
    await expect(brand).toBeVisible();
    // 860 px is one column (`shell.css`): the ring's tighter padding.
    await page.setViewportSize({ width: 860, height: 900 });
    await expect(ring).toHaveCSS("padding-left", "6px");
    await page.setViewportSize({ width: 861, height: 900 });
    await expect(ring).toHaveCSS("padding-left", "10px");
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
