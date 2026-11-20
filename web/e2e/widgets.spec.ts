// Answer widgets run their scripts in a sandbox (`11-artifacts-and-browser.md`
// §3, §4): the script runs after Run scripts; inside the frame there are no
// cookies, no network to the app and no top-level navigation; saved inputs
// persist for their reader across a reload.
//
// The thread is created through the API rather than the Home composer, so the
// test depends only on the thread page rendering the answer's widget.

import { expect, test, type Page } from "@playwright/test";

import { APP_ORIGIN, ARTIFACT_ORIGIN } from "./constants.js";
import { signIn } from "./helpers.js";

const MUTATION_HEADERS = { "x-requested-with": "session", "content-type": "application/json" };

async function trpcMutation<T>(page: Page, path: string, input: unknown): Promise<T> {
  const response = await page.request.post(`${APP_ORIGIN}/api/trpc/${path}`, {
    headers: MUTATION_HEADERS,
    data: input ?? {},
  });
  expect(response.ok(), `${path}: ${response.status()} ${await response.text()}`).toBe(true);
  return ((await response.json()) as { result: { data: T } }).result.data;
}

/** A thread whose root answer is the `widget-answer` fixture. */
async function openWidgetThread(page: Page): Promise<string> {
  const workspace = await trpcMutation<{ id: string }>(page, "workspaces.ensureDefault", {});
  const detail = await trpcMutation<{ tree: { id: string } }>(page, "research.createTree", {
    prompt: "fixture:widget-answer probe the widget sandbox",
    model: "gemini-flash",
    workspaceId: workspace.id,
  });
  await page.goto(`/r/${detail.tree.id}`);
  return detail.tree.id;
}

function widget(page: Page) {
  return page.getByRole("figure", { name: "Answer widget" }).first();
}

test("a widget's script runs sandboxed, without the app's cookies, network or top-level page", async ({
  page,
}) => {
  await signIn(page, { login: "e2e-widget-sandbox" });
  await openWidgetThread(page);
  const figure = widget(page);
  await expect(figure).toBeVisible({ timeout: 60_000 });
  await expect(figure.getByText("Sandbox probe")).toBeVisible();

  const frameElement = figure.locator("iframe");
  await expect(frameElement).toHaveAttribute("sandbox", "allow-scripts");
  await expect(frameElement).toHaveAttribute("src", new RegExp(`^${ARTIFACT_ORIGIN}/w/`));
  const frame = page.frameLocator('figure[aria-label="Answer widget"] iframe').first();
  // The static page shows the markup but runs no widget script.
  await expect(frame.locator("#status")).toHaveText("Scripts have not run.");

  const appUrl = page.url();
  await figure.getByRole("button", { name: "Run the widget's scripts" }).click();
  await expect(figure.getByText("Running")).toBeVisible();
  await expect(frame.locator("#status")).toHaveText("Scripts ran.");
  // The opaque origin has no cookie jar: reading it throws or yields nothing.
  await expect(frame.locator("#cookie")).toHaveText(/^cookie: (blocked \(SecurityError\)|"")$/u);
  // connect-src 'none' refuses the request before it leaves the frame.
  await expect(frame.locator("#fetch")).toHaveText(
    /^fetch: (failed \(TypeError\)|no app origin)$/u,
  );
  await expect(frame.locator("#top")).not.toHaveText("top navigation: not tried");
  await page.waitForTimeout(500);
  expect(page.url()).toBe(appUrl);

  // The same probes from inside the frame's document, with the app origin
  // spelled out.
  const runFrame = page.frames().find((candidate) => candidate.url().startsWith(ARTIFACT_ORIGIN));
  expect(runFrame).toBeTruthy();
  const probe = await runFrame!.evaluate(async (app) => {
    let cookie: string;
    try {
      cookie = `read ${JSON.stringify(document.cookie)}`;
    } catch (error) {
      cookie = `blocked ${(error as Error).name}`;
    }
    let fetched: string;
    try {
      const response = await fetch(`${app}/api/trpc/auth.me`, { credentials: "include" });
      fetched = `status ${response.status}`;
    } catch (error) {
      fetched = `failed ${(error as Error).name}`;
    }
    let storage: string;
    try {
      storage = `available ${String(window.localStorage.length)}`;
    } catch (error) {
      storage = `blocked ${(error as Error).name}`;
    }
    let parentDocument: string;
    try {
      parentDocument = `readable ${window.parent.document.title}`;
    } catch (error) {
      parentDocument = `blocked ${(error as Error).name}`;
    }
    return { origin: window.origin, cookie, fetched, storage, parentDocument };
  }, APP_ORIGIN);
  expect(probe.origin).toBe("null");
  expect(probe.cookie).toMatch(/^(blocked SecurityError|read "")$/u);
  expect(probe.fetched).toBe("failed TypeError");
  expect(probe.storage).toMatch(/^blocked /u);
  expect(probe.parentDocument).toMatch(/^blocked /u);
  expect(page.url()).toBe(appUrl);
});

test("saved inputs persist for their reader across a reload", async ({ page, browser }) => {
  await signIn(page, { login: "e2e-widget-inputs" });
  const treeId = await openWidgetThread(page);
  const figure = widget(page);
  await expect(figure).toBeVisible({ timeout: 60_000 });
  await figure.getByRole("button", { name: "Run the widget's scripts" }).click();
  const frame = page.frameLocator('figure[aria-label="Answer widget"] iframe').first();
  await expect(frame.locator("#status")).toHaveText("Scripts ran.");

  await figure.getByRole("button", { name: "Widget actions" }).click();
  const remember = page.getByRole("menuitemcheckbox", { name: "Remember inputs" });
  await expect(remember).toBeEnabled();
  await remember.click();
  await expect(remember).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");

  const saved = page.waitForResponse(
    (response) =>
      response.url().includes("artifacts.updateState") &&
      (response.request().postData() ?? "").includes("e2e note"),
  );
  await frame.locator("#note").fill("e2e note");
  expect((await saved).ok()).toBe(true);

  await page.reload();
  const reloaded = widget(page);
  await expect(reloaded).toBeVisible({ timeout: 60_000 });
  await reloaded.getByRole("button", { name: "Run the widget's scripts" }).click();
  const again = page.frameLocator('figure[aria-label="Answer widget"] iframe').first();
  await expect(again.locator("#status")).toHaveText("Scripts ran.");
  await expect(again.locator("#note")).toHaveValue("e2e note");

  // Saved inputs belong to their reader: another account cannot read them.
  const history = await page.request.get(
    `${APP_ORIGIN}/api/trpc/artifacts.history?input=${encodeURIComponent(
      JSON.stringify({ treeId, artifactId: "sandbox-probe" }),
    )}`,
  );
  const revision = (
    (await history.json()) as { result: { data: { revisions: { revision: string }[] } } }
  ).result.data.revisions[0]!.revision;
  const other = await browser.newContext();
  try {
    const otherPage = await other.newPage();
    await signIn(otherPage, { login: "e2e-widget-other" });
    const foreign = await otherPage.request.get(
      `${APP_ORIGIN}/api/trpc/artifacts.getState?input=${encodeURIComponent(
        JSON.stringify({ treeId, artifactId: "sandbox-probe", revision }),
      )}`,
    );
    expect(foreign.status()).toBe(404);
  } finally {
    await other.close();
  }
});
