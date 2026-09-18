// Visual baselines (`12-testing-linting-ci.md` §3.6): Home and a finished
// research document in every theme × appearance combination.
//
// Visual regression tests run only on Chromium to avoid redundant cross-engine font rendering differences.
//
// The four combinations are set through `settings.update` rather than through
// the Appearance tab. The pickers are already covered by `library.spec.ts`;
// here they would only add two popups and a debounce to every screenshot.

import { existsSync } from "node:fs";

import { expect, test } from "@playwright/test";

import { APP_ORIGIN } from "./constants.js";
import { signIn, startResearch, waitForAnswer } from "./helpers.js";

type Appearance = "dark" | "light";
type ColorTheme = "green-blob" | "orange-blob";

const COMBINATIONS: { appearance: Appearance; colorTheme: ColorTheme }[] = [
  { appearance: "dark", colorTheme: "green-blob" },
  { appearance: "dark", colorTheme: "orange-blob" },
  { appearance: "light", colorTheme: "green-blob" },
  { appearance: "light", colorTheme: "orange-blob" },
];

test.describe("@visual", () => {
  test("Home and a document in every theme and appearance", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "baselines are Chromium's");
    // Baselines are per platform, because a page rendered by macOS's
    // rasterizer is not the same image Linux produces. A runner whose platform
    // has no baselines skips rather than fails; to add a set, run
    // `npm run test:e2e:update-snapshots` there and commit what it writes.
    const updating = testInfo.config.updateSnapshots !== "none";
    test.skip(
      !updating && !existsSync(testInfo.snapshotPath("home-green-blob-dark.png")),
      `no visual baselines for ${process.platform}`,
    );

    await signIn(page, { login: "e2e-visual" });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Home", level: 1 })).toBeVisible();
    const treeId = await startResearch(page, "What is a bloom filter?");
    await waitForAnswer(page);

    for (const { appearance, colorTheme } of COMBINATIONS) {
      const response = await page.request.post(`${APP_ORIGIN}/api/trpc/settings.update`, {
        headers: { "x-requested-with": "session", "content-type": "application/json" },
        data: { settings: { appearance, colorTheme, reduceMotion: true } },
      });
      expect(response.ok()).toBe(true);

      const name = `${colorTheme}-${appearance}`;

      await page.goto("/");
      await expect(page.locator("html")).toHaveAttribute("data-appearance", appearance);
      await expect(page.locator("html")).toHaveAttribute("data-color-theme", colorTheme);
      await expect(page.getByRole("heading", { name: "Home", level: 1 })).toBeVisible();
      // Mask relative timestamp elements to prevent false visual regression diffs from dynamic time updates.
      await expect(page).toHaveScreenshot(`home-${name}.png`, {
        mask: [page.locator("time")],
        animations: "disabled",
      });

      await page.goto(`/r/${treeId}`);
      await expect(page.getByRole("region", { name: "Sources" })).toBeVisible();
      await expect(page).toHaveScreenshot(`document-${name}.png`, {
        mask: [page.locator("time")],
        animations: "disabled",
      });
    }
  });
});
