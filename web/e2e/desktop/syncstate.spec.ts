// Phase 3, slice 3: the Desktop app's sync states (the mockup's Screen
// entries "Sync: unsent changes", "Sync: refused writes", "Update Session",
// with its default Variants: a toast for a write that needs the person, a
// header badge with a popover for Unsent changes, a bar for offline, a
// dialog for Update Session). Each test asserts its state against the
// mockup's copy, on the real server, with the outbox kept in SQLite through
// the test bridge.

import { expect, test, type Page } from "@playwright/test";

import { APP_ORIGIN } from "../constants.js";

import { openApp, signedInApp } from "./app.js";
import { storedOutbox } from "./files.js";
import { offline, online } from "./net.js";
import { DAY, HOUR, MIN, failNext, seedOutbox, serverNow, sf4, ulid } from "./outbox.js";

const REPLY = "Does region pinning need a restart for read replicas made before 4.2?";
const OFFLINE_BAR =
  "You’re offline. Changes are saved on this Mac and sent when the connection is back.";

const toast = (p: Page) => p.locator(".cs-toast");
const badge = (p: Page) => p.locator(".sx-badge");
const heldReply = (p: Page) => p.locator(".sx-rp");

async function reply(p: Page, text = REPLY) {
  await p.getByRole("textbox", { name: "Write a reply" }).fill(text);
  await p.locator(".fu-box2").getByRole("button", { name: "Reply", exact: true }).click();
}

test.afterEach(async ({ request }) => {
  // no failure left for the next test, and the protocol minimum as it was
  await failNext(request, "", 0).catch(() => undefined);
  await request
    .post(`${APP_ORIGIN}/api/test/config`, {
      headers: { "x-requested-with": "session", "content-type": "application/json" },
      data: { minProtocol: 4 },
    })
    .catch(() => undefined);
});

test("sx-ob-wait and sx-off-app: offline, a reply waits on this Mac with the others", async ({
  context,
}) => {
  const { page, bridge, records } = await signedInApp(context);
  const t = sf4(records);
  await page.goto(`${page.url().replace(/\/$/, "")}${t.path}`);
  await expect(page.locator(".th-q")).toContainText("4.2 is out");
  await offline(page);
  await expect(page.getByText(OFFLINE_BAR)).toBeVisible();
  await reply(page);
  // the reply is in the thread, marked, with the waiting write's message
  const r = heldReply(page);
  await expect(r).toContainText(REPLY);
  await expect(r.locator(".meta")).toContainText("not sent yet");
  await expect(r.locator(".sx-st.sx-wait")).toHaveText(
    "Not sent yet: offline. It is saved on this Mac and sends when the connection is back.",
  );
  // the reply box is empty again: the outbox has the reply
  await expect(page.getByRole("textbox", { name: "Write a reply" })).toHaveValue("");
  // a like waits behind it
  await page.locator(".th-main").getByRole("button", { name: /^Like/ }).first().click();
  await expect(badge(page)).toHaveText("2unsent");
  await expect(badge(page)).not.toHaveClass(/(^| )bad( |$)/);
  await badge(page).click();
  const pop = page.getByRole("dialog", { name: "Unsent changes" });
  await expect(pop.locator(".sx-lh")).toHaveText(
    "Offline. These changes are saved on this Mac and are sent in this order when the connection is back.",
  );
  await expect(pop.getByRole("heading", { name: "Waiting to send" })).toBeVisible();
  await expect(pop.locator(".sx-row").first()).toContainText("Reply in Sablefield");
  await expect(pop.locator(".sx-row").first()).toContainText(REPLY);
  await expect(pop.locator(".sx-row").nth(1)).toContainText("Like on devin_o’s post in Sablefield");
  await expect(pop.locator(".sx-row .sx-rs").first()).toHaveText(
    "Not sent yet: offline. It is saved on this Mac and sends when the connection is back.",
  );
  // stored: the outbox outlives the app
  expect(storedOutbox(bridge).map((e) => e.name)).toEqual([
    "research.createPostFollowUp",
    "likes.set",
  ]);
  // back online: both are sent, in order, and the list empties
  await page.keyboard.press("Escape");
  await online(page);
  await expect(badge(page)).toBeHidden();
  await expect(heldReply(page)).toHaveCount(0);
  await expect(page.locator(".rp").filter({ hasText: REPLY })).toBeVisible();
  await expect.poll(() => storedOutbox(bridge).filter((e) => e.state !== "answered")).toEqual([]);
  bridge.close();
});

test("sx-ob-retry: a reply the server didn't answer is tried again with backoff", async ({
  context,
  request,
}) => {
  const { page, bridge, records } = await signedInApp(context, { path: "/" });
  await page.goto(`${page.url().replace(/\/$/, "")}${sf4(records).path}`);
  await expect(page.locator(".th-q")).toContainText("4.2 is out");
  await failNext(request, "SERVICE_UNAVAILABLE", 2);
  await reply(page);
  await expect(toast(page)).toContainText(
    /^Not sent yet: the server didn’t answer\. Next try in \d+ s \(try 1 of 5\)\./,
  );
  await expect(toast(page).getByRole("button", { name: "Retry now" })).toBeVisible();
  // its item shows the tag only (the message is the toast's)
  await expect(heldReply(page).locator(".sx-tag")).toHaveText("Not sent yet");
  // the third try goes through
  await expect(badge(page)).toBeHidden({ timeout: 20_000 });
  await expect(page.locator(".rp").filter({ hasText: REPLY })).toBeVisible();
  bridge.close();
});

test("sx-ob-failed: a reply that failed 5 times is set aside and the rest are sent", async ({
  context,
  request,
}) => {
  const { page, bridge, records } = await signedInApp(context);
  const t = sf4(records);
  await page.goto(`${page.url().replace(/\/$/, "")}${t.path}`);
  await expect(page.locator(".th-q")).toContainText("4.2 is out");
  await failNext(request, "INTERNAL_SERVER_ERROR", 5);
  await reply(page);
  await page.locator(".th-main").getByRole("button", { name: /^Like/ }).first().click();
  // 1 + 2 + 4 + 8 s of backoff
  await expect(toast(page)).toContainText("Couldn’t save: your reply in Sablefield.", {
    timeout: 30_000,
  });
  await expect(toast(page).getByRole("button", { name: "Retry" })).toBeVisible();
  await expect(toast(page).getByRole("button", { name: "Details" })).toBeVisible();
  await expect(heldReply(page).locator(".sx-tag")).toHaveText("Couldn’t save");
  await expect(heldReply(page).locator(".meta")).toContainText("not saved");
  // the like after it was sent
  await expect(badge(page)).toHaveText("1unsent");
  await expect(badge(page)).toHaveClass(/(^| )bad( |$)/);
  await badge(page).click();
  const pop = page.getByRole("dialog", { name: "Unsent changes" });
  await expect(pop.getByRole("heading", { name: "Needs you" })).toBeVisible();
  await expect(pop.locator(".sx-row .sx-rs")).toHaveText(
    "Couldn’t save. The server failed 5 times (server unavailable). The changes after it were sent.",
  );
  await expect(pop.locator(".sx-row .sx-acts button")).toHaveText([
    "Retry",
    "Copy text",
    "Discard",
  ]);
  // Retry: sent
  await pop.getByRole("button", { name: "Retry" }).click();
  await expect(page.locator(".cs-toast")).toContainText("Sent.");
  await expect(badge(page)).toBeHidden();
  await expect(page.locator(".rp").filter({ hasText: REPLY })).toHaveCount(1);
  bridge.close();
});

/** The app signed in, quit, with writes added to its stored outbox, and
 * started again. */
async function restartWith(
  context: Parameters<typeof signedInApp>[0],
  writes: (now: number, t: ReturnType<typeof sf4>) => Parameters<typeof seedOutbox>[2],
) {
  const app = await signedInApp(context);
  const t = sf4(app.records);
  await expect.poll(() => storedOutbox(app.bridge).length).toBe(0);
  await app.page.close();
  const now = await serverNow(context.request);
  seedOutbox(app.bridge, now, writes(now, t));
  const page = await openApp(context, app.bridge, t.path);
  return { ...app, page, t };
}

test("sx-ob-expired: a reply made 5 days ago is refused as EXPIRED; Send again sends it as a new reply", async ({
  context,
}) => {
  const { page, bridge } = await restartWith(context, (now, t) => [
    {
      name: "research.createPostFollowUp",
      input: { id: ulid(now - 5 * DAY), thread: t.thread, t: REPLY },
      made: 5 * DAY,
      queued: HOUR,
    },
  ]);
  await expect(toast(page)).toContainText("Not saved: your reply in Sablefield.");
  await expect(toast(page).getByRole("button", { name: "Send again" })).toBeVisible();
  await expect(heldReply(page)).toHaveClass(/sx-gone/);
  await expect(heldReply(page).locator(".sx-tag")).toHaveText("Not saved");
  await badge(page).click();
  const row = page.getByRole("dialog", { name: "Unsent changes" }).locator(".sx-row");
  await expect(row.locator(".sx-rh b")).toHaveText("Reply in Sablefield");
  await expect(row.locator(".sx-rh .faint")).toHaveText("5d ago");
  await expect(row.locator(".sx-rs")).toHaveText(
    "Not saved. The server takes a change up to 4 days after it was made, by this Mac’s clock. This one was made 5 days ago.",
  );
  await expect(row.locator(".sx-acts button")).toHaveText(["Send again", "Copy text", "Discard"]);
  await row.getByRole("button", { name: "Send again" }).click();
  await expect(toast(page)).toContainText("Sent as a new reply.");
  await expect(badge(page)).toBeHidden();
  await expect(page.locator(".rp").filter({ hasText: REPLY })).toHaveCount(1);
  bridge.close();
});

test("sx-ob-dropped: a reply queued 3 days ago is dropped without being sent", async ({
  context,
}) => {
  const { page, bridge } = await restartWith(context, (now, t) => [
    {
      name: "research.createPostFollowUp",
      input: { id: ulid(now - 3 * DAY - HOUR), thread: t.thread, t: REPLY },
      made: 3 * DAY + HOUR,
    },
  ]);
  await expect(toast(page)).toContainText("Not sent: your reply in Sablefield.");
  await expect(toast(page).getByRole("button", { name: "Copy text" })).toBeVisible();
  await badge(page).click();
  const row = page.getByRole("dialog", { name: "Unsent changes" }).locator(".sx-row");
  await expect(row.locator(".sx-rs")).toHaveText(
    "Not sent. It waited 3 days without reaching the server, so Session removed it from Unsent changes.",
  );
  await expect(row.locator(".sx-acts button")).toHaveText(["Copy text", "Dismiss"]);
  await row.getByRole("button", { name: "Dismiss" }).click();
  await expect(toast(page)).toContainText("Removed from Unsent changes.");
  await expect(badge(page)).toBeHidden();
  // never sent: the server has no such reply
  await expect(page.locator(".rp").filter({ hasText: REPLY })).toHaveCount(0);
  bridge.close();
});

test("sx-ob-list: Unsent changes lists the writes that need the person, then those waiting", async ({
  context,
}) => {
  const { page, bridge } = await restartWith(context, (now, t) => [
    {
      name: "research.createPostFollowUp",
      input: { id: ulid(now - 5 * DAY), thread: t.thread, t: REPLY },
      made: 5 * DAY,
      queued: HOUR,
    },
    {
      name: "research.createPostFollowUp",
      input: {
        id: ulid(now - 3 * DAY - HOUR),
        thread: t.thread,
        t: "The slides from the evaluation workshop are linked in the second answer.",
      },
      made: 3 * DAY + HOUR,
    },
  ]);
  await expect(badge(page)).toHaveText("2unsent");
  // both were answered (EXPIRED) or dropped before the connection goes
  await expect(page.locator(".sx-rp.sx-gone")).toHaveCount(2);
  await offline(page);
  await reply(page, "Which of these changes apply to open-weight models?");
  await expect(badge(page)).toHaveText("3unsent");
  await badge(page).click();
  const pop = page.getByRole("dialog", { name: "Unsent changes" });
  await expect(pop.locator(".mp-h")).toHaveText("Unsent changes");
  await expect(pop.locator("h3")).toHaveText(["Needs you", "Waiting to send"]);
  await expect(pop.locator(".sx-sec").first().locator(".sx-rs b")).toHaveText([
    "Not saved.",
    "Not sent.",
  ]);
  await expect(pop.locator(".sx-sec").nth(1).locator(".sx-rt")).toHaveText(
    "Which of these changes apply to open-weight models?",
  );
  // the page
  await pop.getByRole("button", { name: "Open Unsent changes" }).click();
  await expect(page).toHaveURL(/\/unsent$/);
  await expect(page.getByRole("heading", { name: "Unsent changes" })).toBeVisible();
  await expect(page.locator(".sx-obp .sx-row")).toHaveCount(3);
  await expect.poll(() => bridge.title).toBe("Session — Unsent changes");
  await online(page);
  await expect(page.locator(".sx-obp .sx-row")).toHaveCount(2);
  bridge.close();
});

test("sx-rf-forbidden: queued moderation refused as FORBIDDEN after the role was removed", async ({
  context,
  request,
}) => {
  const app = await signedInApp(context, {
    scenario: "replication: member",
    edit: (rs) =>
      rs.map((r) =>
        r.record.kind === "member" && r.record["u"] === "ines.v"
          ? { ...r, record: { ...r.record, role: "mod" } }
          : r,
      ),
  });
  const sp = app.records.find(
    (r) => r.record.kind === "space" && r.record["name"] === "replication-club",
  );
  const spId = String(sp?.record["id"]);
  const replies = app.records.filter(
    (r) => r.record.kind === "reply" && r.record["s"] === spId && r.record["u"] !== "ines.v",
  );
  const thread = app.records.find(
    (r) => r.record.kind === "thread" && r.record["s"] === spId,
  )?.record;
  expect(replies.length).toBeGreaterThan(1);
  await app.page.close();
  const now = await serverNow(request);
  const hide = (r: (typeof replies)[number]) => ({
    name: "moderation.decide",
    input: { item: `r:${String(r.record["th"])}:${String(r.record["id"])}`, decision: "hidden" },
    made: 35 * MIN,
  });
  seedOutbox(app.bridge, now, [
    hide(replies[0] as never),
    hide(replies[1] as never),
    { name: "likes.set", input: { thread: thread?.["id"], on: true }, made: 30 * MIN },
  ]);
  // an admin changed the role meanwhile
  const member = app.records.find(
    (r) => r.record.kind === "member" && r.record["sp"] === spId && r.record["u"] === "ines.v",
  );
  if (!member) throw new Error("no member record");
  await request.post(`${APP_ORIGIN}/api/test/records`, {
    headers: { "x-requested-with": "session", "content-type": "application/json" },
    data: { records: [{ key: member.key, record: { ...member.record, role: "member" } }] },
  });
  const page = await openApp(context, app.bridge, "/s/replication-club");
  await expect(toast(page)).toHaveText(
    /2 moderation actions in #replication-club weren’t applied\./,
  );
  await expect(toast(page).getByRole("button", { name: "Details" })).toBeVisible();
  await toast(page).getByRole("button", { name: "Details" }).click();
  await expect(page).toHaveURL(/\/unsent$/);
  const rows = page.locator(".sx-obp .sx-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.locator(".sx-rs")).toHaveText([
    "Not applied. The server refused it.",
    "Not applied. The server refused it.",
  ]);
  await expect(rows.first().locator(".sx-rh b")).toContainText(
    /^Hide a reply by .+ in #replication-club$/,
  );
  await expect(rows.first().locator(".sx-acts button")).toHaveText(["Dismiss"]);
  // the like after them was sent
  await rows.first().getByRole("button", { name: "Dismiss" }).click();
  await expect(rows).toHaveCount(1);
  app.bridge.close();
});

test("sx-up-app: an old app holds its writes; Update Session is a dialog", async ({
  context,
  request,
}) => {
  const { page, bridge, records } = await signedInApp(context);
  await page.goto(`${page.url().replace(/\/$/, "")}${sf4(records).path}`);
  await expect(page.locator(".th-q")).toContainText("4.2 is out");
  const set = (minProtocol: number) =>
    request.post(`${APP_ORIGIN}/api/test/config`, {
      headers: { "x-requested-with": "session", "content-type": "application/json" },
      data: { minProtocol },
    });
  await set(99);
  {
    await reply(page);
    const d = page.getByRole("dialog", { name: "Update Session" });
    await expect(d).toBeVisible();
    await expect(d.locator("p.muted")).toHaveText(
      "This version of Session is too old to sync. 1 changes wait on this Mac and are sent after the update.",
    );
    await expect(d.getByRole("button", { name: "Later" })).toBeVisible();
    await d.getByRole("button", { name: "Download and restart" }).click();
    await expect.poll(() => bridge.opened.at(-1)).toBe(`${APP_ORIGIN}/download`);
    await expect(heldReply(page).locator(".sx-st")).toHaveText(
      "Not sent yet: this version of Session can’t sync. It sends after the update.",
    );
    await badge(page).click();
    await expect(page.getByRole("dialog", { name: "Unsent changes" }).locator(".sx-lh")).toHaveText(
      "This version of Session can’t sync. These changes are saved on this Mac and are sent after the update.",
    );
  }
  await set(4);
  // the next process sends the held writes
  await page.reload();
  await expect(badge(page)).toBeHidden();
  await expect(page.locator(".rp").filter({ hasText: REPLY })).toHaveCount(1);
  bridge.close();
});
