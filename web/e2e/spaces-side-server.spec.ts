// The specs on the side server (`constants.ts`, `playwright.config.ts`),
// whose settings the other specs must not get:
// - a thread address of a thread outside the window (M4 review, client item
//   14; 01 R1, R3; 02 §2.1): the window gives the newest 100 threads of a
//   channel and the older ones no row at all (`SESSION_WEB_SUMMARY_DAYS=0`),
//   so `/c/<name>?t=<id>` of the oldest thread reaches it only through a
//   `threads` read;
// - a channel invite link to a frozen channel (04 B5, B6): the channel is
//   frozen through the test route the account-deletion job's freeze stands
//   for, and the link shows the expired-link message.

import { expect, test } from "@playwright/test";

import { SIDE_ORIGIN } from "./constants.js";
import { signIn } from "./helpers.js";
import { toast } from "./spaces.js";
import { channelName, person, ulid, type Writer } from "./world.js";

test.use({ baseURL: SIDE_ORIGIN });

const LOGIN = "e2e-side";

const w = {
  olga: null as Writer | null,
  many: { id: "", name: "" },
  /** The first thread of #many: older than the 100 after it. */
  first: "",
  frozen: { id: "", name: "", code: "" },
};

test.beforeAll(async ({ browser }) => {
  const olga = await person(browser, "e2e-side-olga", SIDE_ORIGIN);
  const me = await person(browser, LOGIN, SIDE_ORIGIN);
  w.olga = olga;
  w.many.name = channelName("side-many");
  w.many.id = await olga.channel(w.many.name);
  await me.join(w.many.id);
  w.first = await olga.post(w.many.id, "The first thread of the channel");
  await new Promise((resolve) => setTimeout(resolve, 5));
  await olga.all(
    Array.from(
      { length: 100 },
      (_, i) =>
        [
          "threads.create",
          { id: ulid(), space: w.many.id, kind: "post", q: `Newer thread ${i + 1}` },
        ] as const,
    ),
  );
  // the window serves no row of the first thread, not even a summary
  const keys = await me.keys(w.many.id, "window");
  expect(keys).not.toContain(`thread:${w.first}`);
  expect(keys.filter((k) => k.startsWith("thread:"))).toHaveLength(100);

  w.frozen.name = channelName("side-frozen");
  w.frozen.id = await olga.channel(w.frozen.name, { vis: "private" });
  w.frozen.code = await olga.invite(w.frozen.id);
  await olga.freeze(w.frozen.id);
});

test.beforeEach(async ({ page }) => {
  await signIn(page, { login: LOGIN, origin: SIDE_ORIGIN });
});

test("a thread address outside the window arrives through a threads read and is shown", async ({
  page,
}) => {
  const fetched = page.waitForRequest((req) => {
    if (!req.url().endsWith("/api/sync/read")) return false;
    const body = (req.postDataJSON() ?? {}) as { reads?: { tier?: string; threads?: string[] }[] };
    return (body.reads ?? []).some(
      (read) => read.tier === "threads" && (read.threads ?? []).includes(w.first),
    );
  });
  await page.goto(`/c/${w.many.name}?t=${w.first}`);
  await fetched;
  const thread = page.locator(`#card-${w.first}`);
  await expect(thread.locator(".tt-title")).toHaveText("The first thread of the channel");
  await expect(thread).toBeInViewport();
  await expect(page.getByText("This thread is no longer available.")).toHaveCount(0);
});

test("04 B5: a link to a frozen channel shows the expired-link message", async ({ page }) => {
  await page.goto(`/c/${w.frozen.name}#${w.frozen.code}`);
  await expect(toast(page, "alert")).toHaveText(
    "This invite link no longer works. Ask the channel owner for a new one.",
  );
  expect(page.url()).not.toContain(w.frozen.code);
});
