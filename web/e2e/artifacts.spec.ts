// The document preview panel against the real artifact origin
// (`11-artifacts-and-browser.md` §3, `12-testing-linting-ci.md` §3.6).

import { expect, test } from "@playwright/test";

import { ARTIFACT_ORIGIN } from "./constants.js";
import { signInAndOpenHome, startResearch, waitForAnswer } from "./helpers.js";

const REPORT = [
  "# Ring buffers",
  "",
  "A ring buffer trades unbounded history for a fixed allocation.",
  "",
  "## When it is wrong",
  "",
  "When losing the oldest record is not acceptable.",
  "",
].join("\n");

test("an attached document opens in the preview panel and reloads in place", async ({ page }) => {
  await signInAndOpenHome(page, { login: "e2e-artifact" });

  // Set input files programmatically on the hidden file input element.
  await page.locator('form[aria-label="New research"] input[type="file"]').setInputFiles({
    name: "ring-buffers.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(REPORT),
  });
  await expect(page.getByRole("list", { name: "Attachments" })).toContainText("ring-buffers.md");
  // The chip stops saying "uploading…" once the document exists server-side.
  await expect(page.getByRole("list", { name: "Attachments" })).not.toContainText("uploading");

  await startResearch(page, "What does this note get wrong about ring buffers?");
  await waitForAnswer(page);

  const chip = page.getByRole("button", { name: /ring-buffers\.md/ });
  await expect(chip).toBeVisible();
  await chip.click();

  const panel = page.getByTestId("artifact-panel");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("ring-buffers.md");

  const frame = page.getByTestId("artifact-frame");
  const src = await frame.getAttribute("src");
  expect(src ?? "").toContain(`${ARTIFACT_ORIGIN}/a/`);
  expect(await frame.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin");

  // Artifact markdown is rendered on the dedicated artifact origin and embedded in an iframe for cross-origin security isolation.
  const preview = page.frameLocator('[data-testid="artifact-frame"]');
  await expect(preview.getByRole("heading", { name: "Ring buffers" })).toBeVisible();
  await expect(preview.getByRole("heading", { name: "When it is wrong" })).toBeVisible();

  // Verify the 'Open in new tab' button remains functional inside the artifact panel.
  const openInTab = panel.getByRole("link", { name: "Open in new tab" });
  await expect(openInTab).toHaveAttribute("href", src ?? "");
  await expect(openInTab).toHaveAttribute("rel", "noopener noreferrer");

  await panel.getByRole("button", { name: "Reload" }).click();
  await expect(
    page
      .frameLocator('[data-testid="artifact-frame"]')
      .getByRole("heading", { name: "Ring buffers" }),
  ).toBeVisible();

  // Shift-Cmd-E toggles the panel closed and open while preserving the active document.
  await page.keyboard.press("Meta+Shift+E");
  await expect(panel).toBeHidden();
  await page.keyboard.press("Meta+Shift+E");
  await expect(page.getByTestId("artifact-panel")).toBeVisible();

  // Verify the Escape key closes the artifact panel.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("artifact-panel")).toBeHidden();
});
