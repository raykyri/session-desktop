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

/** A follow-up the person asked in a #public thread. */
function myFollowUp(rs: KeyedRecord[]) {
  const sp = spaceId(rs, "public");
  const ths = new Set(
    rs.filter((r) => r.record.kind === "thread" && r.record["s"] === sp).map((r) => r.record["id"]),
  );
  const f = rs.find(
    (r) =>
      r.record.kind === "followup" &&
      ths.has(r.record["th"]) &&
      r.record["u"] === "ines.v" &&
      !r.record["del"],
  );
  return { th: String(f?.record["th"]), fu: String(f?.record["id"]) };
}

/** A source added to a space. */
const firstSource = (rs: KeyedRecord[], space: string) =>
  String(
    rs.find(
      (r) =>
        r.record.kind === "spacesrc" &&
        r.record["sp"] === spaceId(rs, space) &&
        !r.record["rm"] &&
        !r.record["rv"],
    )?.record["src"],
  );

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
  {
    key: "mi-a-item",
    url: (rs) => `/source/${firstSource(rs, "ml-papers")}`,
    run: async (p) => {
      await expect(p.locator(".mi-title")).toBeVisible();
      await expect(p.getByRole("heading", { name: /Asks about this source/ })).toBeVisible();
      // a passage's Ask shows on hover (Desktop); on a phone, the source's box
      if ((p.viewportSize()?.width ?? 0) < 760)
        await p.getByRole("button", { name: "Ask about this source…" }).click();
      else
        await p
          .locator(".mi-b")
          .first()
          .getByRole("button", { name: /Ask about paragraph/ })
          .click();
      await p.locator("#mi-ask").fill("Which table does this figure come from?");
      await p.locator(".mi-askc").getByRole("button", { name: "Ask", exact: true }).click();
      await expect(p).toHaveURL(/\/s\/ml-papers\/t\/[0-9A-Z]{26}$/);
      await expect(p.locator("#th-q")).toHaveText("Which table does this figure come from?");
    },
  },
  {
    // phase 2 review round 1, finding 4: Read on … opens the source's own
    // address (its stored url has no scheme), not a page of the app
    key: "mi-orig",
    url: (rs) => `/source/${firstSource(rs, "ml-papers")}`,
    run: async (p, rs) => {
      const src = firstSource(rs, "ml-papers");
      const meta = rs.find((r) => r.record.kind === "spacesrc" && r.record["src"] === src)?.record[
        "meta"
      ] as { url: string };
      expect(meta.url).not.toMatch(/^https?:/);
      // the original's site, answered here (the sandbox has no outside network)
      await p
        .context()
        .route(/^https:\/\//, (r) =>
          r.fulfill({ contentType: "text/html", body: "<title>original</title>" }),
        );
      const a = p.locator("a.mi-orig");
      await expect(a).toHaveAttribute("href", `https://${meta.url}`);
      const [popup] = await Promise.all([p.waitForEvent("popup"), a.click()]);
      await popup.waitForLoadState();
      expect(popup.url()).toBe(new URL(`https://${meta.url}`).href);
      await popup.close();
    },
  },
  {
    key: "ds-x-report",
    url: (rs) => `/source/${firstSource(rs, "ml-papers")}`,
    run: async (p) => {
      await p.getByRole("button", { name: "More actions" }).click();
      await p.getByRole("menuitem", { name: "Report this source" }).click();
      const d = p.getByRole("dialog", { name: "Report this source" });
      await d.getByLabel("Broken link or wrong reader copy").check();
      await d.getByRole("button", { name: "Send report" }).click();
      await toastSays(p, /Report sent to the moderators of/);
    },
  },
  {
    key: "ds-x-queue",
    scenario: "public: moderator",
    url: "/s/public/manage/sources",
    run: async (p) => {
      await expect(p.getByRole("heading", { name: "Waiting for review" })).toBeVisible();
      const row = p.locator(".ds-mrow").first();
      await row.getByRole("button", { name: "Approve" }).click();
      await toastSays(p, "Approved. Members see it in Sources.");
      await p.getByLabel(/^Moderators/).check();
      await toastSays(p, "Saved.");
    },
  },
  {
    key: "qt-map",
    url: (rs) => `/s/markets/t/${deepAsk(rs, "markets").th}`,
    run: async (p, rs) => {
      const { th, deep, q } = deepAsk(rs, "markets");
      // a phone has no map (the mockup hides it): the Outline sheet is the way to an ask
      if ((p.viewportSize()?.width ?? 0) < 760) {
        await expect(p.getByRole("button", { name: "Map", exact: true })).toBeHidden();
        await p.getByRole("button", { name: "Outline" }).click();
        await p.locator(".qt-olm-sheet").getByRole("button", { name: q }).click();
        await expect(p).toHaveURL(new RegExp(`/t/${th}/a/${deep}$`));
        return;
      }
      await p.getByRole("button", { name: "Map", exact: true }).click();
      const d = p.getByRole("dialog", { name: /Map of this thread/ });
      await expect(d).toBeVisible();
      await d.getByRole("button", { name: q }).click();
      await expect(d).toBeHidden();
      await expect(p).toHaveURL(new RegExp(`/t/${th}/a/${deep}$`));
    },
  },
  {
    key: "qt-compare",
    url: (rs) => `/s/markets/t/${deepAsk(rs, "markets").th}`,
    run: async (p, rs) => {
      const { th } = deepAsk(rs, "markets");
      const fus = rs.filter((r) => r.record.kind === "followup" && r.record["th"] === th);
      const first = fus.find((f) => f.record["par"] === null);
      const other = fus.find((f) => f.record["par"] === null && f !== first);
      await p
        .locator(`#qt-n-${String(first?.record["id"])}`)
        .getByRole("button", { name: "More actions for this ask" })
        .first()
        .click();
      await p.getByRole("menuitem", { name: "Compare with another ask" }).click();
      await expect(p.locator(".qt-pickbar")).toBeVisible();
      await p.locator(".qt-pickbar").getByRole("button", { name: "Open the map" }).click();
      await p
        .getByRole("dialog", { name: /Map of this thread/ })
        .getByRole("button", { name: String(other?.record["q"]) })
        .click();
      await expect(p).toHaveURL(/\/compare\//);
      await expect(p.getByRole("heading", { name: "Compare two branches" })).toBeVisible();
      await p.locator(".qt-cmp #qt-in").fill("Taken together, which branch holds up better?");
      await p.locator(".qt-cmp").getByRole("button", { name: "Ask", exact: true }).click();
      await expect(p).toHaveURL(/\/a\/[0-9A-Z]{26}$/);
    },
  },
  {
    key: "qt-promote",
    url: (rs) => `/s/public/t/${myFollowUp(rs).th}/a/${myFollowUp(rs).fu}`,
    run: async (p, rs) => {
      const { fu } = myFollowUp(rs);
      await p
        .locator(`#qt-n-${fu}`)
        .getByRole("button", { name: "More actions for this ask" })
        .first()
        .click();
      await p.getByRole("menuitem", { name: /Start a thread from this branch/ }).click();
      const d = p.getByRole("dialog", { name: "Start a thread from this branch" });
      await d.getByRole("button", { name: "Start thread" }).click();
      await toastSays(p, /Thread started in #public/);
      await expect(p).toHaveURL(/\/s\/public\/t\/[0-9A-Z]{26}$/);
    },
  },
  {
    key: "ab-page-hist",
    url: "/s/sci-fi/pages/canon-starter-list",
    run: async (p) => {
      // a save makes a second version; History restores the first
      await p.getByRole("button", { name: "Edit", exact: true }).click();
      await p.locator("#ab-pg-b").fill("A new version of the page.");
      await p.getByRole("button", { name: "Save", exact: true }).click();
      await toastSays(p, "Page saved.");
      await p.getByRole("button", { name: "History", exact: true }).click();
      await p
        .getByRole("region", { name: "History" })
        .getByRole("button", { name: "Restore" })
        .first()
        .click();
      await toastSays(p, "Restored. The page history keeps both versions.");
    },
  },
  {
    key: "ab-pages-order",
    url: "/s/sci-fi/about",
    run: async (p) => {
      // /about opens the sidebar's About (a sheet on a phone)
      const names = p.locator(".ab-pgl .ab-pgr span");
      const first = await names.first().textContent();
      await p.getByRole("button", { name: `Move ${first} down` }).click();
      await expect(names.nth(1)).toHaveText(first ?? "");
    },
  },
  {
    key: "ab-set",
    url: "/s/ml-papers/manage/settings",
    run: async (p) => {
      await expect(p.getByRole("tab", { name: "Settings" })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await expect(p.getByRole("button", { name: "Save changes" })).toBeDisabled();
      await p.locator("#st-desc").fill("Papers, preprints and the asks about them.");
      await p.getByRole("button", { name: "Save changes" }).click();
      await toastSays(p, "Settings saved.");
      await expect(p.getByRole("button", { name: "Save changes" })).toBeDisabled();
    },
  },
  {
    key: "cx-owner",
    url: "/s/math/manage/members",
    run: async (p) => {
      const row = p.locator('.mem-row[data-mname="lettie"]');
      await row.getByRole("button", { name: "Make owner" }).click();
      await p
        .getByRole("alertdialog", { name: "Make lettie the owner of #math?" })
        .getByRole("button", { name: "Make owner" })
        .click();
      await toastSays(p, "lettie is now the owner of #math.");
      await expect(row.getByText("Owner")).toBeVisible();
    },
  },
  {
    key: "cx-archive",
    url: "/s/math/manage/settings",
    run: async (p) => {
      await p.getByRole("button", { name: "Archive space" }).click();
      await p
        .getByRole("alertdialog", { name: "Archive #math?" })
        .getByRole("button", { name: "Archive" })
        .click();
      await toastSays(p, "Archived #math. Threads are read-only.");
      await expect(p.getByRole("button", { name: "Unarchive" })).toBeVisible();
    },
  },
  {
    key: "mi-a-saved",
    url: (rs) => `/source/${firstSource(rs, "ml-papers")}`,
    run: async (p) => {
      const title = (await p.locator(".mi-title").textContent()) ?? "";
      const save = p.locator(".mi-acts").getByRole("button", { name: /^Save/ });
      if ((await save.getAttribute("aria-pressed")) !== "true") await save.click();
      await expect(save).toHaveAttribute("aria-pressed", "true");
      await p.goto("/saved");
      await p.getByRole("button", { name: /^Sources/ }).click();
      await p.getByRole("link", { name: title }).click();
      await expect(p.locator(".mi-title")).toHaveText(title);
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
