// Visual baselines (02 §12.2; `12-testing-linting-ci.md` §3.6): Home in
// `centred` and `wide` at 1440 and 1100 px, a channel at 800 px, an open
// branch card and the stacked dialogs, in every theme × appearance
// combination, on the fixture replica (02 §9.6).
//
// Visual regression tests run only on Chromium to avoid redundant
// cross-engine font rendering differences. The baselines are CI's own renders
// (`12-testing-linting-ci.md` §4 says how to regenerate them).
//
// A missing baseline fails in CI. `SESSION_VISUAL_PENDING=1` (set in the
// workflow while a set is being re-rendered) skips instead. Outside CI a
// missing baseline is written, as Playwright does by default.

import { existsSync } from "node:fs";

import { expect, test, type Page } from "@playwright/test";

import { APP_ORIGIN } from "./constants.js";
import { signIn } from "./helpers.js";
import { FIRST_ASK } from "./spaces.js";

type Appearance = "dark" | "light";
type ColorTheme = "green-blob" | "orange-blob";

const COMBINATIONS: { appearance: Appearance; colorTheme: ColorTheme }[] = [
  { appearance: "dark", colorTheme: "green-blob" },
  { appearance: "dark", colorTheme: "orange-blob" },
  { appearance: "light", colorTheme: "green-blob" },
  { appearance: "light", colorTheme: "orange-blob" },
];

async function setTheme(page: Page, appearance: Appearance, colorTheme: ColorTheme) {
  const response = await page.request.post(`${APP_ORIGIN}/api/trpc/settings.update`, {
    headers: { "x-requested-with": "session", "content-type": "application/json" },
    data: { settings: { appearance, colorTheme } },
  });
  expect(response.ok()).toBe(true);
}

async function open(page: Page, path: string) {
  await page.goto(path);
  await expect(page.locator(".tcard").first()).toBeVisible();
  await page.mouse.move(1, 1);
}

test.describe("@visual", () => {
  test("the feed views in every theme and appearance", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "baselines are Chromium's");
    const updating =
      testInfo.config.updateSnapshots === "all" || testInfo.config.updateSnapshots === "changed";
    test.skip(
      Boolean(process.env["CI"]) &&
        process.env["SESSION_VISUAL_PENDING"] === "1" &&
        !updating &&
        !existsSync(testInfo.snapshotPath("home-centred-1440-orange-blob-light.png")),
      `visual baselines for ${process.platform} are pending (SESSION_VISUAL_PENDING=1)`,
    );

    await signIn(page, { login: "e2e-visual" });
    // The account's avatar carries the run's login.
    const mask = [page.locator("header.app-bar button[aria-label^='Account']")];
    const shot = (name: string) =>
      expect.soft(page).toHaveScreenshot(`${name}.png`, { mask, animations: "disabled" });

    for (const { appearance, colorTheme } of COMBINATIONS) {
      await setTheme(page, appearance, colorTheme);
      const name = `${colorTheme}-${appearance}`;
      for (const [layout, toggle] of [
        ["centred", null],
        ["wide", "Expand"],
      ] as const) {
        for (const width of [1440, 1100]) {
          await page.setViewportSize({ width, height: 900 });
          await open(page, "/");
          if (toggle) await page.getByRole("button", { name: toggle }).click();
          await shot(`home-${layout}-${width}-${name}`);
        }
      }
      await page.setViewportSize({ width: 800, height: 900 });
      await open(page, "/c/sci-fi");
      await shot(`channel-800-${name}`);

      await page.setViewportSize({ width: 1440, height: 900 });
      await open(page, "/");
      await page
        .locator(`[data-side="${FIRST_ASK}"]`)
        .getByRole("treeitem", { name: /how does the darknet/ })
        .click();
      await shot(`branch-card-${name}`);

      await open(page, "/c/sci-fi");
      await page.getByRole("button", { name: "About this channel" }).click();
      await page.getByRole("button", { name: "Edit" }).click();
      await expect(page.getByRole("dialog", { name: "Edit #sci-fi" })).toBeVisible();
      await shot(`dialogs-${name}`);
    }
  });
});
