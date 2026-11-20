// Phase 3, slice 3: access changes in the Desktop app (the mockup's
// sx-ax-frozen and sx-ax-frozen-del, Variants "Greyed, notice"): removed
// from a closed space, the app keeps a frozen copy of it (the person's own
// threads and what they wrote under them), read-only and greyed, with one
// short notice; the person can still delete their own threads there. The
// removal itself shows no notice (AGENTS.md).
//
// Each test removes the person after the app's start-up reads are done
// (`trackRequests`), so the removal reaches the app as the server writes it
// to a running app: through the event stream.

import { expect, test } from "@playwright/test";

import { APP_ORIGIN } from "../constants.js";
import type { KeyedRecord } from "../fixtures/mockup.js";

import { signedInApp, spaceId } from "./app.js";
import { trackRequests } from "./net.js";
import { serverWrite } from "./outbox.js";

const NOTICE =
  "You’re no longer a member of #replication-club. This copy on this Mac is read-only and isn’t updated.";

/** The member record of ines.v in a space. */
const memberOf = (records: KeyedRecord[], sp: string) =>
  records.find(
    (r) => r.record.kind === "member" && r.record["sp"] === sp && r.record["u"] === "ines.v",
  );

test("sx-ax-frozen and sx-ax-frozen-del: the copy of a closed space after a removal", async ({
  context,
  request,
}) => {
  const net = trackRequests(context);
  const { page, bridge, records } = await signedInApp(context, {
    scenario: "replication: member",
    path: "/s/replication-club",
  });
  const sp = spaceId(records, "replication-club");
  const mine = records.find(
    (r) => r.record.kind === "thread" && r.record["s"] === sp && r.record["u"] === "ines.v",
  );
  const theirs = records.find(
    (r) => r.record.kind === "thread" && r.record["s"] === sp && r.record["u"] !== "ines.v",
  );
  await expect(page.getByText(String(mine?.record["q"])).first()).toBeVisible();
  await net.quiet();
  // a moderator removes ines.v: the server serves her nothing of the space
  await serverWrite(request, [{ key: String(memberOf(records, sp)?.key), record: null as never }]);
  // the copy: greyed, the notice in place of the composer, "Not a member"
  await expect(page.locator(".sx-frstrip")).toHaveText(NOTICE, { timeout: 20_000 });
  await expect(page.locator(".banner-acts .sx-frz")).toHaveText("Not a member");
  await expect(page.locator(".main.sx-grey")).toBeVisible();
  await expect(page.locator("#app")).toHaveClass(/sx-ro/);
  await expect(page.getByRole("button", { name: /Make a query/ })).toHaveCount(0);
  // her own threads are kept; another member's are not
  await expect(page.getByText(String(mine?.record["q"])).first()).toBeVisible();
  await expect(page.getByText(String(theirs?.record["q"]))).toHaveCount(0);
  // no notice of the removal itself
  await expect(page.locator(".cs-toast")).toHaveCount(0);
  // the space stays in the header
  await expect(
    page.locator(".hnav").getByRole("button", { name: "#replication-club" }),
  ).toBeVisible();

  // her ask in the copy takes no new asks
  await page.getByText(String(mine?.record["q"])).first().click();
  await expect(page.locator(".th-q")).toHaveText(String(mine?.record["q"]));
  await expect(page.getByRole("button", { name: "Ask about this answer" })).toHaveCount(0);

  // sx-ax-frozen-del: her own thread can still be deleted
  await expect(page.locator(".sx-frstrip")).toHaveCount(0);
  await page.locator("article").getByRole("button", { name: "More actions" }).first().click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  const d = page.getByRole("alertdialog");
  await expect(d).toBeVisible();
  await d.getByRole("button", { name: "Delete" }).click();
  // gone from the copy (and from the server)
  await expect(page.getByText(String(mine?.record["q"]))).toHaveCount(0);
  bridge.close();
});

test("sx-ax-frozen: a post of hers in the copy takes no replies, to it or to a reply", async ({
  context,
  request,
}) => {
  const TH = "01M7E164R0RB00000000000TH1";
  const RP = "01M7E164R0RB00000000000RP1";
  const POST = "Frozen-copy check: my own post.";
  const net = trackRequests(context);
  const { page, bridge, records } = await signedInApp(context, {
    scenario: "replication: member",
    path: "/s/replication-club",
    // a post of ines.v's with her own reply under it (the copy keeps both)
    edit: (rs) => {
      const sp0 = spaceId(rs, "replication-club");
      const post = rs.find(
        (r) => r.record.kind === "thread" && r.record["s"] === sp0 && r.record["k"] === "post",
      );
      const rp = rs.find((r) => r.record.kind === "reply" && r.record["s"] === sp0);
      if (!post || !rp) throw new Error("no post or reply to copy");
      return [
        ...rs,
        { key: `thread:${TH}`, record: { ...post.record, id: TH, u: "ines.v", q: POST } },
        { key: `reply:${RP}`, record: { ...rp.record, id: RP, th: TH, u: "ines.v", t: "Mine." } },
      ] as KeyedRecord[];
    },
  });
  const sp = spaceId(records, "replication-club");
  await page.goto(`${page.url().replace(/\/s\/.*$/, "")}/s/replication-club/t/${TH}`);
  await expect(page.locator(".th-q")).toHaveText(POST);
  // a member: the reply box, and Reply under her reply
  await expect(page.getByRole("textbox", { name: "Write a reply" })).toBeVisible();
  await expect(
    page.locator(".rp-acts").getByRole("button", { name: "Reply", exact: true }),
  ).toHaveCount(1);
  await net.quiet();
  await serverWrite(request, [{ key: String(memberOf(records, sp)?.key), record: null as never }]);
  // the copy: the notice in place of the reply box, no Reply under replies
  await expect(page.locator(".th-main .sx-frstrip")).toHaveText(NOTICE, { timeout: 20_000 });
  await expect(page.getByText("Mine.")).toBeVisible();
  await expect(page.getByRole("textbox", { name: /Write a reply|Reply to/ })).toHaveCount(0);
  await expect(
    page.locator(".rp-acts").getByRole("button", { name: "Reply", exact: true }),
  ).toHaveCount(0);
  bridge.close();
});

// A client race found in review round 1 of phase 3 (the coordinator's run):
// a removal the server writes between the user log's read and the space
// log's read of one `SyncClient.sync()` is lost. The space log's resync
// freezes the copy; then `sync()`, still holding the user log as read before
// the removal (the member record), takes the space back as a membership,
// reads it again from no cursor, and keeps nothing of the copy. The app then
// shows the space's landing ("Request to join"). The fix is in
// `web/packages/sync/src/client/client.ts` (the platform's); until it lands
// this test is expected to fail.
test.fail(
  "sx-ax-frozen: a removal between the reads of one sync keeps the copy",
  async ({ context, request }) => {
    const { records } = await (async () => {
      // the scenario first, to know the space and the member record
      const { loadScenario } = await import("../scenario.js");
      return loadScenario(context.request, "replication: member");
    })();
    const sp = spaceId(records, "replication-club");
    const member = memberOf(records, sp);
    let removed = false;
    // the app's first pull of the space log: the removal is written just
    // before the server answers it (the user log was pulled before)
    await context.route(`${APP_ORIGIN}/api/sync/pull`, async (route) => {
      const body = route.request().postDataJSON() as { log?: string } | null;
      if (!removed && body?.log === `space:${sp}`) {
        removed = true;
        await serverWrite(request, [{ key: String(member?.key), record: null as never }]);
      }
      await route.continue();
    });
    const { page, bridge } = await signedInApp(context, {
      scenario: "replication: member",
      path: "/s/replication-club",
    });
    await expect.poll(() => removed).toBe(true);
    await expect(page.locator(".sx-frstrip")).toHaveText(NOTICE, { timeout: 20_000 });
    bridge.close();
  },
);
