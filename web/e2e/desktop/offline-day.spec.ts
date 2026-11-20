// Phase 3's gate (the architecture plan, with the owner's later decisions):
// a day offline with posts, follow-ups and a page edit queued, across a
// reload of the app, replays once on reconnecting (the server holds each
// write once), and a conflict on reconnect follows the sync-state UI
// decisions in AGENTS.md: a STALE decision (a Show whose reply was edited)
// and a FORBIDDEN one (a Hide after the moderator role was removed) each
// show their toast, nothing is applied again in place, and the person's
// text is recoverable with Copy from Unsent changes. The day passes on the
// Playwright clock in the page and on the server's settable clock.

import { expect, test, type Page } from "@playwright/test";

import { APP_ORIGIN } from "../constants.js";
import type { KeyedRecord } from "../fixtures/mockup.js";

import { signedInApp, spaceId } from "./app.js";
import { storedOutbox } from "./files.js";
import { appGo, offline, online, reloadOffline } from "./net.js";
import { DAY, serverNow, serverWrite, sf4 } from "./outbox.js";

const HEADERS = { "x-requested-with": "session", "content-type": "application/json" };
const ASK = "/s/public/t/01M7HWGZJGT7JTFFVSYPX055KV";
const POST = "Notes from Thursday’s reading group are on the wiki page.";
const POST_2 = "Is anyone reading the new survey-methods chapter this week?";
const FOLLOW_UP = "Which of these changes apply to open-weight models?";
const PAGE_LINE = "- Piranesi (Clarke, 2020): a house of endless halls, told from inside it.";
const REPLY = "Does region pinning need a restart for read replicas made before 4.2?";
const SCIFI_REPLY = "Offline reply: the reading group moves to Thursday this week.";

/** Every toast the page shows, in order (one is on screen at a time). */
async function recordToasts(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __toasts: string[] };
    w.__toasts = [];
    new MutationObserver(() => {
      for (const t of document.querySelectorAll(".cs-toast > span:first-child")) {
        const s = t.textContent ?? "";
        if (s && w.__toasts.at(-1) !== s) w.__toasts.push(s);
      }
    }).observe(document, { subtree: true, childList: true, characterData: true });
  });
}
const toasts = (page: Page) =>
  page.evaluate(() => (window as unknown as { __toasts: string[] }).__toasts);

async function post(page: Page, text: string) {
  await page.getByRole("button", { name: /Make a query/ }).click();
  await page.locator(".c2-mode").getByRole("button", { name: "Post" }).click();
  await page.locator("#compose-text").fill(text);
  await page.locator(".c2-end").getByRole("button", { name: "Post" }).click();
}

/** The server's records of a log, as the person reads them (their browser's
 * cookie session). */
async function serverRecords(page: Page, log: string): Promise<KeyedRecord[]> {
  const r = await page.context().request.post(`${APP_ORIGIN}/api/sync/snapshot`, {
    headers: HEADERS,
    data: { log },
  });
  expect(r.ok()).toBe(true);
  const body = (await r.json()) as { records: { key: string; record: KeyedRecord["record"] }[] };
  return body.records.map((x) => ({ key: x.key, record: x.record }));
}

test("a day offline: posts, a follow-up and a page edit replay once; STALE and FORBIDDEN show their toasts", async ({
  context,
  request,
}) => {
  test.setTimeout(240_000);
  // the seed, with bram's reply on the Sablefield 4.2 post hidden; ines.v
  // is an admin of Sablefield and a moderator of #sci-fi
  let hideKey = "";
  let hideRecord: KeyedRecord | null = null;
  const t0 = await serverNow(request).catch(() => Date.now());
  void t0;
  const app = await signedInApp(context, {
    edit: (rs) => {
      const t = sf4(rs);
      const bram = t.replies.find((r) => r.record["u"] === "bram");
      const item = `reply:${String(bram?.record["id"])}`;
      hideKey = `hide:${item}`;
      hideRecord = {
        key: hideKey,
        record: { kind: "hide", item, s: t.space, ed: 0, createdAt: "2026-11-16T09:00:00Z" },
      };
      return [...rs, hideRecord];
    },
  });
  const { bridge, records } = app;
  let page = app.page;
  await recordToasts(page);
  const t = sf4(records);
  const scifi = spaceId(records, "sci-fi");
  const now = await serverNow(request);
  await page.clock.install({ time: now });
  await page.reload();
  await expect(page.getByRole("button", { name: /^Account: / })).toBeVisible();

  // ---- offline: the writes of a day ----
  await offline(page);
  await appGo(page, `/s/public`);
  await post(page, POST);
  await expect(page.locator(".th-q")).toHaveText(POST);
  await appGo(page, `/s/public`);
  await post(page, POST_2);
  await expect(page.locator(".th-q")).toHaveText(POST_2);
  // a follow-up on ines.v's ask
  await appGo(page, `${ASK}`);
  await page.locator(".p-foot").getByRole("button", { name: "Ask about this answer" }).click();
  await page.locator("#qt-in").fill(FOLLOW_UP);
  await page.locator("#qt-comp").getByRole("button", { name: "Ask", exact: true }).click();
  await expect(page.locator("#qt-comp")).toHaveCount(0);
  await expect(page.getByText(FOLLOW_UP).first()).toBeVisible();
  // a page edit (#ml-papers, where ines.v is an admin)
  await appGo(page, `/s/ml-papers/pages/reading-list`);
  await page.getByRole("button", { name: "Edit" }).click();
  const body = page.getByPlaceholder("Write the page");
  await body.fill(`${await body.inputValue()}\n\n${PAGE_LINE}`);
  await page.locator(".abp-edbar").getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(PAGE_LINE.slice(2))).toBeVisible();
  // a reply, and Show on bram's hidden reply (Sablefield)
  await appGo(page, `${t.path}`);
  await page.getByRole("textbox", { name: "Write a reply" }).fill(REPLY);
  await page.locator(".fu-box2").getByRole("button", { name: "Reply", exact: true }).click();
  await page.getByRole("button", { name: "Show it again" }).click();
  // a reply and a Hide in #sci-fi (as its moderator)
  const scifiThread = records.find(
    (r) =>
      r.record.kind === "thread" &&
      r.record["s"] === scifi &&
      r.record["k"] === "post" &&
      records.some((x) => x.record.kind === "reply" && x.record["th"] === r.record["id"]),
  );
  await appGo(page, `/s/sci-fi/t/${String(scifiThread?.record["id"])}`);
  await page.getByRole("textbox", { name: "Write a reply" }).fill(SCIFI_REPLY);
  await page.locator(".fu-box2").getByRole("button", { name: "Reply", exact: true }).click();
  const target = page
    .locator(".rp")
    .filter({ hasNot: page.locator(".sx-rp") })
    .first();
  const hidden = (await target.locator("p").first().textContent()) ?? "";
  await target.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Hide" }).click();

  const NAMES = [
    "threads.create",
    "threads.create",
    "research.forkNode",
    "pages.update",
    "research.createPostFollowUp",
    "moderation.decide",
    "research.createPostFollowUp",
    "moderation.decide",
  ];
  await expect.poll(() => storedOutbox(bridge).map((e) => e.name)).toEqual(NAMES);
  await expect(page.locator(".sx-badge")).toHaveText(`${NAMES.length}unsent`);

  // ---- the app is restarted, still offline; the day passes ----
  await reloadOffline(page);
  await expect(page.locator(".sx-badge")).toHaveText(`${NAMES.length}unsent`);
  await page.clock.fastForward("24:00:00");
  const later = now + DAY;
  const clock = await request.post(`${APP_ORIGIN}/api/test/clock`, {
    headers: HEADERS,
    data: { now: later },
  });
  expect(clock.ok()).toBe(true);
  // meanwhile on the server: bram edits his hidden reply, and an admin of
  // #sci-fi makes ines.v a member
  const bram = t.replies.find((r) => r.record["u"] === "bram");
  const member = records.find(
    (r) => r.record.kind === "member" && r.record["sp"] === scifi && r.record["u"] === "ines.v",
  );
  await serverWrite(request, [
    {
      key: String(bram?.key),
      record: {
        ...(bram?.record ?? { kind: "reply" }),
        t: "Edited: the discount code is gone. A comparison of managed Postgres hosts is at cheapdb.example/compare.",
        edited: true,
      },
    },
    // the hide record counts the edit (`ed`), as the server's edit of a
    // hidden reply does: its rev moves on
    {
      key: hideKey,
      record: { ...(hideRecord as unknown as KeyedRecord).record, ed: 1 },
    },
    {
      key: String(member?.key),
      record: { ...(member?.record ?? { kind: "member" }), role: "member" },
    },
  ]);

  // ---- back online: the outbox replays, in order ----
  await online(page);
  // what the outbox keeps: only the refused Hide (the STALE Show left it
  // with its toast)
  await expect
    .poll(
      () =>
        storedOutbox(bridge)
          .filter((e) => e.state !== "answered")
          .map((e) => `${e.name} ${e.state} ${e.error?.code ?? ""}`),
      { timeout: 30_000 },
    )
    .toEqual(["moderation.decide refused FORBIDDEN"]);
  await expect(page.locator(".sx-badge")).toHaveText("1unsent");
  await expect
    .poll(() => toasts(page))
    .toEqual(
      expect.arrayContaining([
        "Show wasn’t applied because bram edited the reply after you chose Show.",
        "1 moderation action in #sci-fi wasn’t applied.",
      ]),
    );
  // the FORBIDDEN Hide stays in Unsent changes; nothing is applied again
  await page.locator(".sx-badge").click();
  const pop = page.getByRole("dialog", { name: "Unsent changes" });
  const row = pop.locator(".sx-row");
  await expect(row).toHaveCount(1);
  await expect(row.locator(".sx-rh b")).toHaveText(/^Hide a reply by .+ in #sci-fi$/);
  await expect(row.locator(".sx-rs")).toHaveText("Not applied. The server refused it.");
  await row.getByRole("button", { name: "Dismiss" }).click();
  await expect(page.locator(".sx-badge")).toBeHidden();

  // ---- the server holds each write once ----
  const pub = await serverRecords(page, `space:${spaceId(records, "public")}`);
  const threads = pub.filter((r) => r.record.kind === "thread");
  expect(threads.filter((r) => r.record["q"] === POST)).toHaveLength(1);
  expect(threads.filter((r) => r.record["q"] === POST_2)).toHaveLength(1);
  expect(
    pub.filter((r) => r.record.kind === "followup" && r.record["q"] === FOLLOW_UP),
  ).toHaveLength(1);
  const ml = await serverRecords(page, `space:${spaceId(records, "ml-papers")}`);
  const list = ml.filter((r) => r.record.kind === "page" && r.record["slug"] === "reading-list");
  expect(list).toHaveLength(1);
  expect((list[0]?.record["text"] as string[]).at(-1)).toBe(PAGE_LINE);
  const sci = await serverRecords(page, `space:${scifi}`);
  expect(
    sci.filter((r) => r.record.kind === "reply" && r.record["t"] === SCIFI_REPLY),
  ).toHaveLength(1);
  // the Hide was not applied: the reply is not hidden
  const target_ = sci.find((r) => r.record.kind === "reply" && r.record["t"] === hidden);
  expect(target_).toBeDefined();
  expect(sci.some((r) => r.key === `hide:reply:${String(target_?.record["id"])}`)).toBe(false);
  const sab = await serverRecords(page, `space:${t.space}`);
  expect(sab.filter((r) => r.record.kind === "reply" && r.record["t"] === REPLY)).toHaveLength(1);
  // the Show was not applied: bram's reply is still hidden, on the server
  // and in the app
  expect(sab.some((r) => r.key === hideKey)).toBe(true);
  await appGo(page, `${t.path}`);
  await expect(page.getByText("This reply is hidden by a moderator.")).toBeVisible();
  // and the outbox is empty
  await expect.poll(() => storedOutbox(bridge).filter((e) => e.state !== "answered")).toEqual([]);
  page = app.page;
  bridge.close();
});

test("a refused write keeps the person's text: Copy text from Unsent changes", async ({
  context,
  request,
}) => {
  // ines.v replies in Sablefield offline; meanwhile she is banned there
  const app = await signedInApp(context);
  const { page, bridge, records } = app;
  const t = sf4(records);
  await appGo(page, `${t.path}`);
  await offline(page);
  await page.getByRole("textbox", { name: "Write a reply" }).fill(REPLY);
  await page.locator(".fu-box2").getByRole("button", { name: "Reply", exact: true }).click();
  await expect(page.locator(".sx-badge")).toHaveText("1unsent");
  await serverWrite(request, [
    {
      key: `ban:${t.space}:ines.v`,
      record: {
        kind: "ban",
        id: `${t.space}:ines.v`,
        sp: t.space,
        u: "ines.v",
        createdAt: "2026-11-16T09:00:00Z",
      },
    },
  ]);
  await online(page);
  await expect(page.locator(".cs-toast")).toContainText("1 change in Sablefield wasn’t applied.");
  await page.locator(".sx-badge").click();
  const row = page.getByRole("dialog", { name: "Unsent changes" }).locator(".sx-row");
  await expect(row.locator(".sx-rt")).toHaveText(REPLY);
  await expect(row.locator(".sx-rs")).toHaveText("Not applied. The server refused it.");
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: new URL(page.url()).origin,
  });
  await row.getByRole("button", { name: "Copy text" }).click();
  await expect(page.locator(".cs-toast")).toHaveText("Text copied.");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(REPLY);
  bridge.close();
});
