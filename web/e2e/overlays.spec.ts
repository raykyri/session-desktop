// Phase 2 review round 1 ("also check"): on Mobile Web, Back closes the top
// sheet, menu or dialog and leaves the screen where it was, and focus goes
// back to what opened it (the mockup's overlay history: on Mobile Web menus,
// popovers and the About and request sheets get history entries, dialogs on
// both layouts). Unsaved input asks before Back discards it (OV_DIRTY).

import { expect, test, type Locator, type Page } from "@playwright/test";

import type { KeyedRecord } from "./fixtures/mockup.js";
import { loadScenario, signInAs } from "./scenario.js";

const MOBILE = { width: 390, height: 844 };
const DESKTOP = { width: 1318, height: 900 };

async function open(p: Page, url: string, scenario = "seed") {
  const { records } = await loadScenario(p.context().request, scenario);
  await signInAs(p.context());
  await p.goto(url);
  return records;
}

/** Open a thread of the space's page from its row, in the app (so Back has
 * the space to go to). */
async function openRow(p: Page, records: KeyedRecord[], space: string, kind: "ask" | "post") {
  const sp = records.find((r) => r.record.kind === "space" && r.record["name"] === space)?.record[
    "id"
  ];
  const ths = records
    .filter(
      (r) =>
        r.record.kind === "thread" &&
        r.record["s"] === sp &&
        r.record["k"] === kind &&
        !r.record["del"] &&
        (kind === "post" || r.record["sum"]),
    )
    .map((r) => String(r.record["id"]));
  const link = p.locator(ths.map((id) => `.rows > article a[href$="/t/${id}"]`).join(", ")).first();
  await expect(link).toBeVisible();
  await link.click();
  await expect(p).toHaveURL(/\/t\//);
}

/** `opener` opens `overlay`; Back closes it, the address stays, and focus is
 * on `focus` (the opener by default) again. */
async function backCloses(
  p: Page,
  opener: Locator,
  overlay: Locator,
  o: { focus?: Locator; then?: () => Promise<void> } = {},
) {
  await expect(opener).toBeVisible();
  const url = p.url();
  await opener.click();
  await o.then?.();
  await expect(overlay).toBeVisible();
  await p.goBack();
  await expect(overlay).toBeHidden();
  expect(p.url()).toBe(url);
  await expect(o.focus ?? opener).toBeFocused();
  // the screen is still the one it was: Back again leaves it
}

const firstThread = async (p: Page) => {
  const row = p.locator(".rows > article").first();
  await expect(row).toBeVisible();
  await row.locator("a, [role=link]").first().click();
  await expect(p).toHaveURL(/\/t\//);
};

test.describe("Back on Mobile Web", () => {
  test.use({ viewport: MOBILE });

  test("the account menu", async ({ page: p }) => {
    await open(p, "/");
    await backCloses(
      p,
      p.getByRole("button", { name: /^Account: / }),
      p.getByRole("menu", { name: "Account" }),
    );
  });

  test("a thread's item menu, and the dialog it opens", async ({ page: p }) => {
    await open(p, "/s/public");
    await firstThread(p);
    const more = p.getByRole("button", { name: "More actions", exact: true }).first();
    await backCloses(p, more, p.getByRole("menu").first());
    await more.click();
    await p.getByRole("menuitem", { name: /Report|Delete/ }).click();
    const d = p.getByRole("dialog").or(p.getByRole("alertdialog")).first();
    await expect(d).toBeVisible();
    const url = p.url();
    await p.goBack();
    await expect(d).toBeHidden();
    expect(p.url()).toBe(url);
    await expect(more).toBeFocused();
  });

  test("the composer's model menu", async ({ page: p }) => {
    await open(p, "/s/public");
    await p.getByRole("button", { name: /Make a query/ }).click();
    await backCloses(
      p,
      p.locator(".composer .mp-base > button"),
      p.getByRole("menu", { name: "Model" }),
    );
    // the composer is still open, with nothing typed
    await expect(p.locator("#compose-text")).toBeVisible();
  });

  test("the About sheet of a space", async ({ page: p }) => {
    await open(p, "/s/sci-fi");
    await backCloses(
      p,
      p.getByRole("button", { name: "About" }).first(),
      p.getByRole("tab", { name: "About" }),
    );
  });

  test("the request to join dialog", async ({ page: p }) => {
    await open(p, "/s/replication-club");
    await backCloses(
      p,
      p.getByRole("button", { name: "Request to join" }).first(),
      p.getByRole("dialog").first(),
    );
  });

  test("the add key dialog", async ({ page: p }) => {
    await open(p, "/settings/keys");
    await backCloses(
      p,
      p.getByRole("button", { name: "Add a key" }),
      p.getByRole("dialog", { name: "Add an API key" }),
    );
  });

  test("the skill editor", async ({ page: p }) => {
    await open(p, "/s/sci-fi/manage/skills");
    await backCloses(
      p,
      p.getByRole("button", { name: "Add a skill" }),
      p.getByRole("dialog", { name: "Add a skill" }),
    );
  });

  test("a screen opened from a menu: Back goes to the screen under the menu", async ({
    page: p,
  }) => {
    await open(p, "/");
    await p.getByRole("button", { name: /^Account: / }).click();
    await p
      .getByRole("menu", { name: "Account" })
      .getByRole("menuitem", { name: "Notifications" })
      .click();
    await expect(p).toHaveURL(/\/notifications$/);
    await p.goBack();
    await expect(p).toHaveURL(/127\.0\.0\.1:\d+\/$/);
    await expect(p.getByRole("menu", { name: "Account" })).toBeHidden();
    // the menu's entry went with it: one more Back leaves the app
    await p.goBack();
    expect(p.url()).toBe("about:blank");
  });

  test("unsaved input in a dialog: Back asks, and the dialog stays until Discard", async ({
    page: p,
  }) => {
    await open(p, "/s/sci-fi/manage/skills");
    const url = p.url();
    await p.getByRole("button", { name: "Add a skill" }).click();
    const d = p.getByRole("dialog", { name: "Add a skill" });
    await d.locator("input").first().fill("cite-editions");
    await p.goBack();
    const ask = p.getByRole("alertdialog", { name: "Discard this skill?" });
    await expect(ask).toBeVisible();
    await expect(
      ask.getByText("The name, description and instructions you entered will be deleted."),
    ).toBeVisible();
    expect(p.url()).toBe(url);
    // Back again stays (Keep editing)
    await p.goBack();
    await expect(ask).toBeHidden();
    await expect(d).toBeVisible();
    await expect(d.locator("input").first()).toHaveValue("cite-editions");
    // Escape asks too; Discard closes the editor and the screen stays
    await p.keyboard.press("Escape");
    await expect(ask).toBeVisible();
    await ask.getByRole("button", { name: "Discard" }).click();
    await expect(d).toBeHidden();
    expect(p.url()).toBe(url);
    await expect(p.getByRole("button", { name: "Add a skill" })).toBeFocused();
  });
});

// The leave guard on drafts other than the composer (the mockup's OV_DIRTY
// screens): a reply, a follow-up, the page editor, the skill editor and a
// space's settings ask before Back discards them.
for (const [layout, viewport] of [
  ["Desktop", DESKTOP],
  ["Mobile Web", MOBILE],
] as const)
  test.describe(`unsaved input, ${layout}`, () => {
    test.use({ viewport });

    /** Back asks `title`; Keep editing stays where it was; Back and Discard
     * leaves. */
    async function guarded(p: Page, title: string, body: string, kept: () => Promise<void>) {
      const url = p.url();
      await p.goBack();
      const ask = p.getByRole("alertdialog", { name: title });
      await expect(ask).toBeVisible();
      await expect(ask.getByText(body)).toBeVisible();
      await ask.getByRole("button", { name: "Keep editing" }).click();
      await expect(ask).toBeHidden();
      expect(p.url()).toBe(url);
      await kept();
      await p.goBack();
      await p
        .getByRole("alertdialog", { name: title })
        .getByRole("button", { name: "Discard" })
        .click();
      await expect(p).not.toHaveURL(url);
    }

    test("a reply", async ({ page: p }) => {
      const rs = await open(p, "/s/public");
      await openRow(p, rs, "public", "post");
      const box = p.locator("#fu-input");
      await box.fill("A reply I have not sent.");
      await guarded(p, "Discard your reply?", "The text you wrote will be deleted.", () =>
        expect(box).toHaveValue("A reply I have not sent."),
      );
    });

    test("a follow-up", async ({ page: p }) => {
      const rs = await open(p, "/s/markets");
      await openRow(p, rs, "markets", "ask");
      await p.getByRole("button", { name: "Ask about this answer" }).first().click();
      const box = p.locator("#qt-in");
      await box.fill("A follow-up I have not sent.");
      await guarded(p, "Discard your follow-up?", "The text you wrote will be deleted.", () =>
        expect(box).toHaveValue("A follow-up I have not sent."),
      );
    });

    test("the page editor", async ({ page: p }) => {
      await open(p, "/s/sci-fi");
      if (viewport.width < 760) await p.getByRole("button", { name: "About" }).first().click();
      else await p.getByRole("tab", { name: "About" }).click();
      await p.locator(".ab-pgl > li .ab-pgr").first().click();
      await expect(p).toHaveURL(/\/pages\//);
      await p.getByRole("button", { name: "Edit", exact: true }).click();
      await p.locator("#ab-pg-b").fill("An edit I have not saved.");
      await guarded(
        p,
        "Discard your changes to this page?",
        "The page stays as it was before you edited it.",
        () => expect(p.locator("#ab-pg-b")).toHaveValue("An edit I have not saved."),
      );
    });

    test("a space's settings", async ({ page: p }) => {
      await open(p, "/s/ml-papers");
      await p.getByRole("button", { name: "Manage #ml-papers" }).first().click();
      await p.getByRole("tab", { name: "Settings" }).click();
      await p.locator("#st-desc").fill("A description I have not saved.");
      await guarded(
        p,
        "Discard your changes to the settings?",
        "You haven’t saved your changes to the settings of #ml-papers.",
        () => expect(p.locator("#st-desc")).toHaveValue("A description I have not saved."),
      );
    });
  });
