// Phase 3, slice 3: access changes in the Desktop app (the mockup's
// sx-ax-frozen and sx-ax-frozen-del, Variants "Greyed, notice"): removed
// from a closed space, the app keeps a frozen copy of it (the person's own
// threads and what they wrote under them), read-only and greyed, with one
// short notice; the person can still delete their own threads there. The
// removal itself shows no notice (AGENTS.md).

import { expect, test } from "@playwright/test";

import { signedInApp, spaceId } from "./app.js";
import { serverWrite } from "./outbox.js";

const NOTICE =
  "You’re no longer a member of #replication-club. This copy on this Mac is read-only and isn’t updated.";

test("sx-ax-frozen and sx-ax-frozen-del: the copy of a closed space after a removal", async ({
  context,
  request,
}) => {
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
  // a moderator removes ines.v: the server serves her nothing of the space
  const member = records.find(
    (r) => r.record.kind === "member" && r.record["sp"] === sp && r.record["u"] === "ines.v",
  );
  await serverWrite(request, [{ key: String(member?.key), record: null as never }]);
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

  // sx-ax-frozen-del: her own thread can still be deleted
  await page.getByText(String(mine?.record["q"])).first().click();
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
