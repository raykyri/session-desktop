// Phase 2b, slice 3 (the part built): pages (read, edit, a save someone else
// made meanwhile), Manage › Skills, an ask tree's outline and its asks
// below, and a link added to a space's sources. On Desktop and Mobile Web.

import { expect, test, type Page } from "@playwright/test";

import type { KeyedRecord } from "./fixtures/mockup.js";
import { loadScenario, signInAs } from "./scenario.js";

const HEADERS = { "x-requested-with": "session", "content-type": "application/json" };

interface Screen {
  key: string;
  scenario?: string;
  url: string | ((r: KeyedRecord[]) => string);
  run: (p: Page, r: KeyedRecord[]) => Promise<void>;
}

const toastSays = (p: Page, t: string | RegExp) =>
  expect(p.locator(".cs-toast").getByText(t)).toBeVisible();

const spaceId = (rs: KeyedRecord[], name: string) =>
  String(rs.find((r) => r.record.kind === "space" && r.record["name"] === name)?.record["id"]);

/** The ask thread of a space with the most follow-ups, and a follow-up two levels down. */
function deepAsk(rs: KeyedRecord[], space: string) {
  const sp = spaceId(rs, space);
  const fus = rs.filter((r) => r.record.kind === "followup");
  const threads = rs.filter(
    (r) => r.record.kind === "thread" && r.record["s"] === sp && r.record["k"] === "ask",
  );
  const best = threads
    .map((t) => ({ t, n: fus.filter((f) => f.record["th"] === t.record["id"]).length }))
    .sort((a, b) => b.n - a.n)[0];
  const th = String(best?.t.record["id"]);
  const deep = fus.find((f) => f.record["th"] === th && f.record["par"] !== null);
  return { th, deep: String(deep?.record["id"]), q: String(deep?.record["q"]) };
}

const SCREENS: Screen[] = [
  {
    key: "ab-page",
    url: "/s/sci-fi/pages/canon-starter-list",
    run: async (p) => {
      await expect(p.getByRole("heading", { name: "Canon starter list", level: 1 })).toBeVisible();
      await expect(p.getByRole("heading", { name: "Classics" })).toBeVisible();
      await p.getByRole("button", { name: "History", exact: true }).click();
      await expect(p.getByRole("region", { name: "History" })).toBeVisible();
    },
  },
  {
    key: "ab-page-edit",
    url: "/s/sci-fi/pages/canon-starter-list",
    run: async (p) => {
      await p.getByRole("button", { name: "Edit", exact: true }).click();
      const body = p.locator("#ab-pg-b");
      await body.fill(`${await body.inputValue()}\n\nAdded: the 2026 reissues.`);
      await p.getByRole("button", { name: "Save", exact: true }).click();
      await toastSays(p, "Page saved.");
      await expect(p.getByText("Added: the 2026 reissues.")).toBeVisible();
    },
  },
  {
    key: "ec-page",
    url: "/s/sci-fi/pages/canon-starter-list",
    run: async (p, rs) => {
      await p.getByRole("button", { name: "Edit", exact: true }).click();
      await p.locator("#ab-pg-b").fill("My version of the page.");
      // someone else saves first: the record's version moves on the server
      const page = rs.find(
        (r) => r.record.kind === "page" && r.record["slug"] === "canon-starter-list",
      );
      const moved = {
        ...page!.record,
        ver: Number(page!.record["ver"]) + 1,
        text: ["Their version."],
      };
      const r = await p.context().request.post("/api/test/records", {
        headers: HEADERS,
        data: { records: [{ key: page!.key, record: moved }] },
      });
      expect(r.ok()).toBeTruthy();
      await p.getByRole("button", { name: "Save", exact: true }).click();
      await expect(
        p.getByText("Someone else changed this page while you were editing."),
      ).toBeVisible();
      await p.getByRole("button", { name: "Copy my text and reload" }).click();
      await expect(p.locator("#ab-pg-b")).toHaveValue("Their version.");
      await expect(p.locator(".ed-mine-t")).toHaveValue(/My version of the page\./);
    },
  },
  {
    key: "ab-skills-mg",
    url: "/s/sci-fi/manage/skills",
    run: async (p) => {
      await expect(p.getByRole("tab", { name: "Skills" })).toHaveAttribute("aria-selected", "true");
      await p.getByRole("button", { name: "Add a skill" }).click();
      const d = p.getByRole("dialog", { name: "Add a skill" });
      await d.getByRole("button", { name: "Add skill" }).click();
      await expect(d.getByText("Add a name.")).toBeVisible();
      await d.locator("#ab-sk-n").fill("listing-anthologies");
      await d
        .locator("#ab-sk-d")
        .fill("Lists anthologies on a theme. Use when someone asks for collections.");
      await d.getByRole("button", { name: "Add skill" }).click();
      await toastSays(p, "Added listing-anthologies. It shows in About.");
      const row = p.locator(".ab-skr").filter({ hasText: "listing-anthologies" });
      await row.getByRole("button", { name: "Remove" }).click();
      await p
        .getByRole("alertdialog", { name: "Remove listing-anthologies?" })
        .getByRole("button", { name: "Remove" })
        .click();
      await toastSays(p, "Removed listing-anthologies.");
      await expect(row).toHaveCount(0);
    },
  },
  {
    key: "qt-outline",
    url: (rs) => `/s/markets/t/${deepAsk(rs, "markets").th}`,
    run: async (p, rs) => {
      const { th, deep, q } = deepAsk(rs, "markets");
      if ((p.viewportSize()?.width ?? 0) < 760) {
        await p.getByRole("button", { name: "Outline" }).click();
        await p.locator(".qt-olm-sheet").getByRole("button", { name: q }).click();
      } else await p.locator("#qt-ol").getByRole("button", { name: q }).click();
      await expect(p).toHaveURL(new RegExp(`/t/${th}/a/${deep}$`));
      // the selected ask is shown, opened under the ask above it
      await expect(p.locator(`#qt-n-${deep}`)).toHaveClass(/\bon\b/);
      await expect(p.locator(`#qt-n-${deep}`)).toBeVisible();
    },
  },
  {
    key: "ds-s-paste",
    url: "/s/ml-papers",
    run: async (p) => {
      if ((p.viewportSize()?.width ?? 0) < 760)
        await p.getByRole("button", { name: "Sources" }).first().click();
      const field = p.locator("#ds-url");
      await field.fill("https://example.org/a-new-paper");
      await field.press("Enter");
      await expect(field).toHaveValue("");
      await expect(p.getByText("example.org").first()).toBeVisible();
    },
  },
];

async function open(p: Page, s: Screen) {
  const { records } = await loadScenario(p.context().request, s.scenario ?? "seed");
  await signInAs(p.context());
  await p.goto(typeof s.url === "string" ? s.url : s.url(records));
  return records;
}

for (const [layout, viewport] of [
  ["Desktop", { width: 1318, height: 900 }],
  ["Mobile Web", { width: 390, height: 844 }],
] as const) {
  test.describe(`slice 3 screens, ${layout}`, () => {
    test.use({ viewport });
    for (const s of SCREENS) {
      test(s.key, async ({ page }) => {
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(e.message));
        const rs = await open(page, s);
        await s.run(page, rs);
        expect(errors).toEqual([]);
      });
    }
  });
}
