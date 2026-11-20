// Phase 2b, slice 1: reading, on the real server with the mockup's data
// (`e2e/fixtures/mockup.ts`, loaded per test through the test routes). Each
// Screen entry of the mockup this slice builds has a check that its state
// renders, on Desktop and on Mobile Web; the navigation flows of the mockup's
// navigation suite (back links, search, notifications, Saved, system states)
// follow.

import { expect, test, type Page } from "@playwright/test";

import { APP_ORIGIN } from "./constants.js";
import { loadScenario, pathFor, signInAs } from "./scenario.js";

const HEADERS = { "x-requested-with": "session", "content-type": "application/json" };

interface Screen {
  key: string;
  scenario?: string;
  args?: unknown;
  url: string;
  /** Signed out. */
  out?: boolean;
  /** What shows that the state rendered. */
  check: (p: Page) => Promise<void>;
}

const heading = (p: Page, name: string | RegExp) =>
  expect(p.getByRole("heading", { name }).first()).toBeVisible();
const text = (p: Page, t: string | RegExp) => expect(p.getByText(t).first()).toBeVisible();

const ASK = (end: string, extra: Record<string, unknown> = {}) => ({
  space: "public",
  end,
  ...extra,
});

const SCREENS: Screen[] = [
  {
    key: "mb-home",
    scenario: "replication: member",
    url: "/",
    check: async (p) => {
      await heading(p, "Home");
      await text(p, "New threads from the spaces you joined.");
      await expect(p.getByRole("listitem").first()).toBeVisible();
    },
  },
  {
    key: "pg-feed",
    url: "/",
    check: async (p) => {
      await expect(p.getByRole("button", { name: "Show more" })).toBeVisible();
      const before = await p.locator(".rows > article").count();
      await p.getByRole("button", { name: "Show more" }).click();
      expect(await p.locator(".rows > article").count()).toBeGreaterThan(before);
    },
  },
  {
    key: "as-home-empty",
    scenario: "no joined spaces",
    url: "/",
    check: async (p) => {
      await text(p, "Join a space to see its threads here");
      await expect(p.getByRole("button", { name: "Browse spaces" })).toBeVisible();
    },
  },
  {
    key: "mb-space",
    scenario: "replication: member",
    url: "/s/replication-club",
    check: async (p) => {
      await heading(p, "#replication-club");
      await text(p, "214 members");
      await expect(p.getByRole("searchbox", { name: "Search in #replication-club" })).toBeVisible();
    },
  },
  {
    key: "mb-thread",
    scenario: "replication: member",
    url: "/s/replication-club/t/01M7H6F3P012CRWKEQVTVA6PV4",
    check: async (p) => {
      await text(p, "Agent answer");
      await heading(p, /Follow-ups/);
    },
  },
  {
    key: "nm-search",
    url: "/search?q=replication",
    check: async (p) => {
      await heading(p, "Search");
      await expect(p.locator(".sr-row").first()).toBeVisible();
      await expect(p.locator("mark.sr-m").first()).toHaveText(/^replicat/i);
    },
  },
  {
    key: "nm-switcher",
    url: "/",
    check: async (p) => {
      await p.getByRole("button", { name: "Switch space" }).click();
      await expect(p.getByRole("searchbox", { name: "Find a space" })).toBeVisible();
      await p.getByRole("searchbox", { name: "Find a space" }).fill("math");
      await expect(p.locator(".pop .pop-row:visible")).toHaveCount(1);
      await p.keyboard.press("Escape");
      await expect(p.getByRole("searchbox", { name: "Find a space" })).toHaveCount(0);
    },
  },
  {
    key: "as-notif",
    scenario: "asks: an answer is ready",
    url: "/",
    check: async (p) => {
      await p.getByRole("button", { name: /^Notifications, \d+ unread/ }).click();
      await expect(p.getByRole("dialog", { name: "Notifications" })).toBeVisible();
      await text(p, /The agent answered your ask/);
    },
  },
  {
    key: "pg-notifs",
    url: "/notifications",
    check: async (p) => {
      await heading(p, "Notifications");
      await p.getByRole("button", { name: "Threads" }).click();
      await expect(p.getByRole("button", { name: "Threads" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await text(p, /followed up on your ask/);
    },
  },
  {
    key: "as-run",
    scenario: "asks: your ask",
    args: ASK("running"),
    url: "/s/public/t/01M7HWS780000000000000000B",
    check: (p) => text(p, "Researching"),
  },
  {
    key: "as-stopped",
    scenario: "asks: your ask",
    args: ASK("stopped"),
    url: "/s/public/t/01M7HWS780000000000000000D",
    check: (p) => text(p, "Stopped."),
  },
  {
    key: "as-fail-tokens",
    scenario: "asks: your ask",
    args: ASK("tokens", { space: "markets", tok: 30000 }),
    url: "/s/markets/t/01M7HWS780000000000000000E",
    check: (p) =>
      text(p, /You’ve used this week’s included tokens|You’ve used this month’s included tokens/),
  },
  {
    key: "as-fail-key",
    scenario: "asks: your ask",
    args: ASK("key"),
    url: "/s/public/t/01M7HWS780000000000000000F",
    check: (p) => text(p, "Couldn’t finish the answer"),
  },
  {
    key: "as-fail-rate",
    scenario: "asks: your ask",
    args: ASK("rate"),
    url: "/s/public/t/01M7HWS780000000000000000G",
    check: (p) => text(p, /limiting requests/),
  },
  {
    key: "as-fail-access",
    scenario: "asks: your ask",
    args: ASK("access"),
    url: "/s/public/t/01M7HWS780000000000000000H",
    check: (p) => text(p, /The agent didn’t run/),
  },
  {
    key: "as-fail-interrupted",
    scenario: "asks: your ask",
    args: ASK("interrupted"),
    url: "/s/public/t/01M7HWS780000000000000000J",
    check: (p) => text(p, /The server restarted while the agent worked/),
  },
  {
    key: "sf-faq",
    url: "/s/sablefield",
    check: async (p) => {
      await expect(p.getByRole("navigation", { name: "Topics" }).first()).toBeVisible();
      await text(p, "Sync rules");
      await expect(p.getByRole("tab", { name: "About" })).toHaveAttribute("aria-selected", "true");
    },
  },
  {
    key: "sf-faq-match",
    url: "/s/sablefield",
    check: async (p) => {
      await p.getByRole("searchbox", { name: /Search answers in Sablefield/ }).fill("sync rule");
      await expect(p.locator("#faq-res .rf-row").first()).toBeVisible();
      await expect(p.getByRole("button", { name: "Ask", exact: true })).toBeEnabled();
    },
  },
  {
    key: "sf-faq-topic",
    url: "/s/sablefield/topics/sync-rules",
    check: async (p) => {
      await heading(p, /Sync rules/);
      await expect(p.getByRole("button", { name: "All topics" })).toBeVisible();
    },
  },
  {
    key: "sf-faq-latest",
    url: "/s/sablefield/latest",
    check: async (p) => {
      await expect(p.getByRole("button", { name: "Topics", exact: true })).toBeVisible();
      await expect(p.getByRole("button", { name: "Sort and filter posts" })).toBeVisible();
    },
  },
  {
    key: "nv-404",
    url: "/s/public/wiki/start-here",
    check: async (p) => {
      await heading(p, "Page not found");
      await expect(p.getByRole("button", { name: "Go to Home" })).toBeVisible();
    },
  },
  {
    key: "nv-404-space",
    url: "/s/field-notes",
    check: (p) => heading(p, "No space named #field-notes"),
  },
  {
    key: "nv-search-empty",
    url: "/search",
    check: async (p) => {
      await expect(
        p.getByRole("searchbox", { name: "Search threads, spaces, pages and sources" }),
      ).toBeFocused();
      await text(p, /Type a word or phrase to search/);
    },
  },
  {
    key: "nv-search-all",
    url: "/search?q=void",
    check: async (p) => {
      await heading(p, /Asks inside threads/);
      const all = p.getByRole("button", { name: /^Show all \d+/ });
      await expect(all).toBeVisible();
      await all.click();
      await expect(all).toHaveCount(0);
    },
  },
  {
    key: "nv-search-in",
    url: "/search?q=port&in=public",
    check: async (p) => {
      await text(p, "In #public");
      await expect(p.getByRole("searchbox", { name: "Search in #public" })).toBeVisible();
    },
  },
  {
    key: "pg-search",
    url: "/search?q=data",
    check: async (p) => {
      await expect(p.locator(".sr-row").first()).toBeVisible();
    },
  },
  {
    key: "nv-saved-empty",
    scenario: "saved: nothing",
    url: "/saved",
    check: (p) =>
      text(
        p,
        "Nothing saved yet. Use the bookmark on a thread, an ask or a source to keep it here.",
      ),
  },
  {
    key: "pg-saved",
    url: "/saved",
    check: async (p) => {
      await heading(p, "Saved");
      await text(p, /\d+ threads/);
      await expect(p.locator(".sv-row").first()).toBeVisible();
    },
  },
];

async function open(p: Page, s: Screen) {
  const { records } = await loadScenario(p.context().request, s.scenario ?? "seed", {
    args: s.args,
  });
  if (!s.out) await signInAs(p.context());
  await p.goto(pathFor(records, `session.app${s.url}`));
}

for (const [layout, viewport] of [
  ["Desktop", { width: 1318, height: 900 }],
  ["Mobile Web", { width: 390, height: 844 }],
] as const) {
  test.describe(`slice 1 screens, ${layout}`, () => {
    test.use({ viewport });
    for (const s of SCREENS) {
      // the topic column and the sidebar are not shown at phone width
      if (layout === "Mobile Web" && s.key === "sf-faq") continue;
      test(`${s.key} renders`, async ({ page }) => {
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(e.message));
        await open(page, s);
        await s.check(page);
        expect(errors).toEqual([]);
      });
    }
  });
}

test.describe("navigation", () => {
  test("a thread opened from a notification focuses its heading, and its back link returns", async ({
    page,
  }) => {
    await open(page, {
      key: "nv-ntfocus",
      scenario: "asks: an answer is ready",
      url: "/",
      check: () => Promise.resolve(),
    });
    await page.getByRole("button", { name: /^Notifications/ }).click();
    await page.getByRole("button", { name: /The agent answered your ask/ }).click();
    await expect(page.locator("#th-q")).toBeFocused();
    const back = page.getByRole("button", { name: "Back to Notifications" });
    await expect(back).toBeVisible();
    await back.click();
    await expect(page).toHaveURL(/\/notifications$/);
  });

  test("a thread opened from Search names Search in its back link", async ({ page }) => {
    await open(page, {
      key: "nv-from-search",
      url: "/search?q=replication",
      check: () => Promise.resolve(),
    });
    await page.locator(".sr-row a").first().click();
    await expect(page.getByRole("button", { name: "Back to Search" })).toBeVisible();
    await page.getByRole("button", { name: "Back to Search" }).click();
    await expect(page).toHaveURL(/\/search\?q=replication/);
  });

  test("a topic thread opened from Home has the Home back link", async ({ page }) => {
    await open(page, { key: "nv-sf-crumb", url: "/", check: () => Promise.resolve() });
    // a Sablefield thread (a space with topics) from Home's feed
    await page
      .locator(".rows article")
      .filter({ has: page.locator(".row-sp", { hasText: "Sablefield" }) })
      .first()
      .locator(".row-link")
      .click();
    await expect(page).toHaveURL(/\/s\/sablefield\/t\//);
    await expect(page.getByRole("button", { name: "Back to Home" })).toBeVisible();
  });

  test("a thread opened by its address links back to its space", async ({ page }) => {
    await open(page, SCREENS.find((s) => s.key === "mb-thread") as Screen);
    await page
      .getByRole("button", { name: /#replication-club/ })
      .first()
      .click();
    await expect(page).toHaveURL(/\/s\/replication-club$/);
  });

  test("searching in a space opens Search scoped to it", async ({ page }) => {
    await open(page, SCREENS.find((s) => s.key === "mb-space") as Screen);
    await page.getByRole("searchbox", { name: "Search in #replication-club" }).fill("grokking");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/search\?q=grokking&in=replication-club/);
    await expect(page.getByText("In #replication-club")).toBeVisible();
  });

  test("Mark all as read clears the unread count", async ({ page }) => {
    await open(page, SCREENS.find((s) => s.key === "pg-notifs") as Screen);
    await expect(page.getByRole("button", { name: /^Notifications, \d+ unread/ })).toBeVisible();
    await page.getByRole("button", { name: "Mark all as read" }).click();
    await expect(page.getByRole("button", { name: "Notifications", exact: true })).toBeVisible();
  });
});

test.describe("system states", () => {
  test("nv-offline: the offline bar, and Try again once the connection is back", async ({
    page,
    context,
  }) => {
    await open(page, SCREENS[0] as Screen);
    await heading(page, "Home");
    await context.setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event("offline")));
    const bar = page.getByRole("status").filter({ hasText: "You’re offline." });
    await expect(bar).toBeVisible();
    // still offline: Try again keeps the bar
    await bar.getByRole("button", { name: "Try again" }).click();
    await expect(bar).toBeVisible();
    // the connection is back
    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect(bar).toHaveCount(0);
  });

  test("nv-loading: skeleton rows while the first reads load", async ({ page }) => {
    await loadScenario(page.context().request);
    await signInAs(page.context());
    await page.route("**/api/sync/snapshot", async (r) => {
      await new Promise((res) => setTimeout(res, 1500));
      await r.continue();
    });
    await page.goto("/");
    await expect(page.getByRole("status").filter({ hasText: "Loading…" })).toBeVisible();
    await heading(page, "Home");
  });

  test("de-load-auth: a sign-in the server no longer takes shows the error with Retry", async ({
    page,
  }) => {
    await loadScenario(page.context().request);
    await signInAs(page.context());
    await page.route("**/api/sync/snapshot", (r) =>
      r.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error: { code: "UNAUTHORIZED", message: "x" },
          serverTime: 0,
        }),
      }),
    );
    await page.goto("/");
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: "Your sign-in expired. Sign in again to load your spaces." }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  });

  test("nv-deleted: a post its author deleted with nothing under it", async ({ page }) => {
    const { records } = await loadScenario(page.context().request, "seed", {
      edit: (rs) => {
        const post = rs.find((r) => r.record.kind === "thread" && r.record["k"] === "post");
        if (post) {
          post.record["del"] = true;
          post.record["q"] = "";
          const th = post.record["id"];
          return rs.filter((r) => !(r.record.kind === "reply" && r.record["th"] === th));
        }
        return rs;
      },
    });
    await signInAs(page.context());
    const post = records.find(
      (r) => r.record.kind === "thread" && r.record["del"] === true,
    )?.record;
    const space = records.find(
      (r) => r.record.kind === "space" && r.record["id"] === post?.["s"],
    )?.record;
    await page.goto(`/s/${String(space?.["name"])}/t/${String(post?.["id"])}`);
    await heading(page, "This thread was deleted");
    await expect(page.getByRole("button", { name: "Go to Home" })).toBeVisible();
  });

  test("sx-up-web: below the server's minimum protocol, Update Session with Reload and Later", async ({
    page,
    request,
  }) => {
    await open(page, SCREENS[0] as Screen);
    await heading(page, "Home");
    await request.post(`${APP_ORIGIN}/api/test/config`, {
      headers: HEADERS,
      data: { minProtocol: 99 },
    });
    try {
      // the next read the server refuses
      await page.evaluate(() => window.dispatchEvent(new Event("online")));
      const dialog = page.getByRole("dialog", { name: "Update Session" });
      await expect(dialog).toBeVisible();
      await expect(
        dialog.getByText("Session has been updated. Reload the page to keep saving changes."),
      ).toBeVisible();
      await dialog.getByRole("button", { name: "Later" }).click();
      await expect(dialog).toHaveCount(0);
    } finally {
      await request.post(`${APP_ORIGIN}/api/test/config`, {
        headers: HEADERS,
        data: { minProtocol: 1 },
      });
    }
  });

  test("Mobile Web: Sources and About open the sidebar as a sheet that Escape closes", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page, SCREENS.find((s) => s.key === "mb-space") as Screen);
    await page.getByRole("button", { name: "About" }).first().click();
    await expect(page.getByRole("tab", { name: "About" })).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("tab", { name: "About" })).toBeHidden();
  });
});
