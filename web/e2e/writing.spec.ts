// Phase 2b, slice 2: writing and members, on the real server with the
// mockup's data. Each Screen entry of the slice has a check on Desktop and
// on Mobile Web that its state renders or that its flow works (writes go
// through the sync client's outbox to the server and come back as records).

import { expect, test, type Page } from "@playwright/test";

import type { KeyedRecord } from "./fixtures/mockup.js";
import { APP_ORIGIN } from "./constants.js";
import { loadScenario, pathFor, recordsOf, signInAs } from "./scenario.js";

interface Screen {
  key: string;
  scenario?: string;
  args?: unknown;
  url: string;
  out?: boolean;
  /** Changes the scenario's records first. */
  edit?: (r: KeyedRecord[]) => KeyedRecord[];
  /** The thread to open, found in the scenario's records (`:thread` in url). */
  thread?: (r: KeyedRecord[]) => KeyedRecord | undefined;
  run: (p: Page) => Promise<void>;
}

/** The person's own post with replies in a space. */
const myPost = (space: string) => (rs: KeyedRecord[]) => {
  const sp = rs.find((r) => r.record.kind === "space" && r.record["name"] === space)?.record["id"];
  return rs.find(
    (r) =>
      r.record.kind === "thread" &&
      r.record["s"] === sp &&
      r.record["k"] === "post" &&
      r.record["u"] === "ines.v" &&
      rs.some((x) => x.record.kind === "reply" && x.record["th"] === r.record["id"]),
  );
};

/** A post in a space with a reply by someone else. */
const postWithReply = (space: string) => (rs: KeyedRecord[]) => {
  const sp = rs.find((r) => r.record.kind === "space" && r.record["name"] === space)?.record["id"];
  return rs.find(
    (r) =>
      r.record.kind === "thread" &&
      r.record["s"] === sp &&
      r.record["k"] === "post" &&
      rs.some(
        (x) =>
          x.record.kind === "reply" &&
          x.record["th"] === r.record["id"] &&
          x.record["u"] !== "ines.v",
      ),
  );
};

const text = (p: Page, t: string | RegExp) => expect(p.getByText(t).first()).toBeVisible();
const dialog = (p: Page, name: string | RegExp) =>
  p.getByRole("dialog", { name }).or(p.getByRole("alertdialog", { name }));
const toastSays = (p: Page, t: string | RegExp) =>
  expect(p.locator(".cs-toast").getByText(t)).toBeVisible();

const SCREENS: Screen[] = [
  {
    key: "nm-space",
    url: "/s/replication-club",
    run: async (p) => {
      await expect(p.getByRole("heading", { name: "#replication-club" })).toBeVisible();
      await expect(p.getByRole("button", { name: "Request to join" })).toBeVisible();
      await text(p, "Post a plan before you start a replication.");
    },
  },
  {
    key: "nm-request",
    url: "/s/replication-club",
    run: async (p) => {
      await p.getByRole("button", { name: "Request to join" }).click();
      const d = dialog(p, "Request to join #replication-club");
      await expect(d).toBeVisible();
      const send = d.getByRole("button", { name: "Send request" });
      await expect(send).toBeDisabled();
      await d.locator("#cs-ans-0").fill("The grokking results on modular arithmetic.");
      await d.getByLabel("I have read the rules").check();
      await send.click();
      await toastSays(p, /Request sent to the moderators of #replication-club/);
      // pending: the Requested menu with View and Withdraw
      await p.getByRole("button", { name: "Requested" }).click();
      await p.getByRole("menuitem", { name: "Withdraw request" }).click();
      await dialog(p, "Withdraw your request?").getByRole("button", { name: "Withdraw" }).click();
      await toastSays(p, "Request withdrawn.");
      await expect(p.getByRole("button", { name: "Request to join" })).toBeVisible();
    },
  },
  {
    key: "nm-thread",
    url: "/s/replication-club/t/01M7HVAH3GCWYN0S5H6NX9WKRT",
    run: async (p) => {
      await expect(
        p.getByRole("heading", { name: "This thread is in a closed space" }),
      ).toBeVisible();
      await text(p, "Only members of #replication-club can read it.");
    },
  },
  {
    key: "nm-unlisted",
    url: "/s/ward-7-tenants",
    run: async (p) => {
      await text(p, "Closed, unlisted");
      await text(p, /Only members can see this space\. Ask a member for an invite link\./);
    },
  },
  {
    key: "pd-space",
    scenario: "replication: pending",
    url: "/s/replication-club",
    run: async (p) => {
      await expect(p.getByRole("button", { name: "Requested" })).toBeVisible();
    },
  },
  {
    key: "pd-withdraw",
    scenario: "replication: pending",
    url: "/s/replication-club",
    run: async (p) => {
      await p.getByRole("button", { name: "Requested" }).click();
      await p.getByRole("menuitem", { name: "View your request" }).click();
      await expect(dialog(p, "Your request to join #replication-club")).toBeVisible();
      await p.getByRole("button", { name: "Withdraw request" }).click();
      await expect(dialog(p, "Withdraw your request?")).toBeVisible();
      await text(
        p,
        "Moderators of #replication-club will no longer see it. You can request again at any time.",
      );
    },
  },
  {
    key: "cx-declined",
    scenario: "replication: denied",
    url: "/s/replication-club",
    run: async (p) => {
      await expect(p.getByRole("region").or(p.locator(".cs-denied")).first()).toBeVisible();
      await text(p, "Your request was declined");
      // the 14 days after a decline (2b design finding 1, the mockup's cxDeniedCard)
      await expect(p.locator(".cs-denied .cs-fine")).toHaveText(
        /^You can request again on [A-Z][a-z]{2} \d{1,2}\.$/,
      );
      await expect(p.getByRole("button", { name: "Request declined" }).first()).toBeDisabled();
    },
  },
  {
    key: "cx-declined-again",
    scenario: "replication: denied",
    // declined 20 days before the scenario's clock: the waiting period has passed
    edit: (rs) =>
      rs.map((r) =>
        r.record.kind === "request" && r.record["st"] === "declined"
          ? {
              ...r,
              record: { ...r.record, updatedAt: "2026-10-27T10:00:00Z", retryAt: undefined },
            }
          : r,
      ),
    url: "/s/replication-club",
    run: async (p) => {
      await expect(p.locator(".cs-denied .cs-fine")).toHaveText(
        "The waiting period has passed. You can send a new request with new answers.",
      );
      await expect(p.getByRole("button", { name: "Request to join" }).first()).toBeEnabled();
    },
  },
  {
    key: "mb-space",
    scenario: "replication: member",
    url: "/s/replication-club",
    run: async (p) => {
      await expect(p.getByRole("button", { name: "Joined" })).toBeVisible();
      await expect(p.locator(".rows > article").first()).toBeVisible();
    },
  },
  {
    key: "mb-ask",
    scenario: "replication: member",
    url: "/s/replication-club",
    run: async (p) => {
      await p.getByRole("button", { name: /Make a query/ }).click();
      await p
        .locator("#compose-text")
        .fill("Re-run the robustness table with the revised weights.");
      await expect(p.getByText("Use included tokens")).toBeVisible();
      await p.getByRole("button", { name: "Ask", exact: true }).last().click();
      await expect(p).toHaveURL(/\/s\/replication-club\/t\/[0-9A-Z]{26}$/);
      await expect(p.locator("#th-q")).toHaveText(
        "Re-run the robustness table with the revised weights.",
      );
    },
  },
  {
    key: "mb-thread",
    scenario: "replication: member",
    url: "/s/replication-club/t/01M7H6F3P012CRWKEQVTVA6PV4",
    run: async (p) => {
      await p.getByRole("button", { name: "Share" }).first().click();
      const d = dialog(p, "Share this thread");
      await expect(d).toBeVisible();
      await expect(
        d.getByText(/Only members of #replication-club can open this link/),
      ).toBeVisible();
      await d.getByRole("button", { name: "Done" }).click();
      await expect(d).toBeHidden();
    },
  },
  {
    key: "mb-leave",
    scenario: "replication: member",
    url: "/s/replication-club",
    run: async (p) => {
      await p.getByRole("button", { name: "Joined" }).click();
      await p.getByRole("menuitem", { name: "Leave space" }).click();
      const d = dialog(p, "Leave #replication-club?");
      await expect(d.getByText(/you’ll need to request to join again/)).toBeVisible();
      await d.getByRole("button", { name: "Leave space" }).click();
      await toastSays(p, "You left #replication-club.");
      await expect(p.getByRole("button", { name: "Request to join" })).toBeVisible();
    },
  },
  {
    key: "md-space",
    scenario: "replication: moderator",
    url: "/s/replication-club",
    run: async (p) => {
      await expect(p.getByRole("button", { name: "Manage #replication-club" })).toBeVisible();
      await expect(p.getByLabel(/requests and reports to review/)).toBeVisible();
    },
  },
  {
    key: "md-queue",
    scenario: "replication: moderator",
    args: { seen: true },
    url: "/s/replication-club/manage/requests",
    run: async (p) => {
      await expect(p.getByRole("heading", { name: "Manage" })).toBeVisible();
      await expect(p.getByRole("tab", { name: /Requests/ })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      const first = p.locator(".rq-card").first();
      const who = (await first.locator(".rq-nm .faint").textContent()) ?? "";
      await first.getByRole("button", { name: "Approve" }).click();
      await dialog(p, `Approve the request from ${who}?`)
        .getByRole("button", { name: "Approve" })
        .click();
      await toastSays(p, `Approved ${who}. They can read #replication-club now.`);
      await expect(p.locator(".rq-decided").getByText(who)).toBeVisible();
    },
  },
  {
    key: "md-decline",
    scenario: "replication: moderator",
    url: "/s/replication-club/manage/requests",
    run: async (p) => {
      const first = p.locator(".rq-card").first();
      const who = (await first.locator(".rq-nm .faint").textContent()) ?? "";
      await first.getByRole("button", { name: "Decline" }).click();
      const d = dialog(p, `Decline the request from ${who}?`);
      await d.locator("#cx-declnote").fill("Name the result you want to replicate.");
      await d.getByRole("button", { name: "Decline" }).click();
      await toastSays(p, `Declined ${who}.`);
      await p.locator(".cs-toast").getByRole("button", { name: "Undo" }).click();
      await expect(
        p.locator(".rq-card .rq-nm .faint").getByText(who, { exact: true }),
      ).toBeVisible();
    },
  },
  {
    key: "md-members",
    scenario: "replication: moderator",
    url: "/s/replication-club/manage/members",
    run: async (p) => {
      await expect(p.getByRole("searchbox", { name: "Find a member" })).toBeVisible();
      const row = p
        .locator(".mem-row")
        .filter({ has: p.getByRole("button", { name: "Ban" }) })
        .first();
      const who = (await row.getAttribute("data-mname")) ?? "";
      await row.getByRole("button", { name: "Remove" }).click();
      await dialog(p, `Remove ${who} from #replication-club?`)
        .getByRole("button", { name: "Remove" })
        .click();
      await toastSays(p, `Removed ${who}.`);
      await expect(p.locator(`.mem-row[data-mname="${who}"]`)).toHaveCount(0);
    },
  },
  {
    key: "md-links",
    scenario: "replication: moderator",
    url: "/s/replication-club/manage/invites",
    run: async (p) => {
      await expect(p.getByRole("heading", { name: "Invite links" })).toBeVisible();
      await p.getByRole("button", { name: "Create link" }).click();
      await toastSays(p, /Link created: .*\/i\/[0-9a-z]{10}/);
    },
  },
  {
    key: "sx-op-members",
    scenario: "sablefield: an open space to moderate",
    url: "/s/sablefield/manage/members",
    run: async (p) => {
      await expect(p.getByRole("tab", { name: /Members/ })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await expect(p.getByRole("tab", { name: "Invites" })).toHaveCount(0);
    },
  },
  {
    key: "sx-op-report",
    scenario: "sablefield: an open space to moderate",
    url: "/s/sablefield/manage/reports",
    run: async (p) => {
      await text(p, /People report answers, follow-up answers, posts and replies/);
    },
  },
  {
    key: "sf-report",
    url: "/s/sablefield/t/01M5JT1KR02CNFDXPGDT7X75TM",
    run: async (p) => {
      await p.locator(".p-foot").getByRole("button", { name: "More actions" }).click();
      await p.getByRole("menuitem", { name: "Report a problem" }).click();
      const d = dialog(p, /^Report this /);
      await d.getByRole("radio", { name: /Out of date/ }).click();
      await d.locator("#sf-repnote").fill("The limit changed on Nov 10.");
      await d.getByRole("button", { name: "Send report" }).click();
      await toastSays(p, /Report sent to the moderators of/);
    },
  },
  {
    key: "ta-share",
    url: "/s/public/t/01M7HWGZJGT7JTFFVSYPX055KV",
    run: async (p) => {
      await p.getByRole("button", { name: "Share" }).first().click();
      await expect(p.getByRole("menuitem", { name: "Copy link" })).toBeVisible();
      await expect(p.getByRole("menuitem", { name: "Share to X" })).toBeVisible();
      await p.keyboard.press("Escape");
      await expect(p.getByRole("menuitem", { name: "Copy link" })).toBeHidden();
    },
  },
  {
    key: "likes-saves",
    url: "/s/public/t/01M7HWGZJGT7JTFFVSYPX055KV",
    run: async (p) => {
      const like = p.locator(".p-foot [data-toggle=liked]");
      const before = Number(await like.locator(".num").textContent());
      const was = (await like.getAttribute("aria-pressed")) === "true";
      await like.click();
      await expect(like).toHaveAttribute("aria-pressed", String(!was));
      await expect(like.locator(".num")).toHaveText(String(before + (was ? -1 : 1)));
      const save = p.locator(".p-foot [data-toggle=saved]");
      const saved = (await save.getAttribute("aria-pressed")) === "true";
      await save.click();
      await expect(save).toHaveAttribute("aria-pressed", String(!saved));
      // the server kept them: a reload shows the same
      await p.reload();
      await expect(p.locator(".p-foot [data-toggle=liked]")).toHaveAttribute(
        "aria-pressed",
        String(!was),
      );
      await expect(p.locator(".p-foot [data-toggle=saved]")).toHaveAttribute(
        "aria-pressed",
        String(!saved),
      );
    },
  },
  {
    key: "as-fu-ask",
    url: "/s/public/t/01M7HWGZJGT7JTFFVSYPX055KV",
    run: async (p) => {
      await expect(p.locator(".th-fus > .fu").first()).toBeVisible();
      const n = await p.locator(".th-fus > .fu").count();
      await p.locator(".p-foot").getByRole("button", { name: "Ask about this answer" }).click();
      await p.locator("#qt-in").fill("Which of these changes apply to open-weight models?");
      await p.locator("#qt-comp").getByRole("button", { name: "Ask", exact: true }).click();
      await expect(p.locator("#qt-comp")).toHaveCount(0);
      await expect(p.locator(".th-fus > .fu")).toHaveCount(n + 1);
      await text(p, "Which of these changes apply to open-weight models?");
    },
  },
  {
    key: "as-discard",
    url: "/s/public/t/01M7HWGZJGT7JTFFVSYPX055KV",
    run: async (p) => {
      await p.locator(".p-foot").getByRole("button", { name: "Ask about this answer" }).click();
      await p.locator("#qt-in").fill("Which of these changes apply to open-weight models?");
      await p.locator("#qt-comp").getByRole("button", { name: "Cancel" }).click();
      const d = p.getByRole("alertdialog", { name: "Discard your follow-up?" });
      await expect(d).toBeVisible();
      await d.getByRole("button", { name: "Keep editing" }).click();
      await expect(p.locator("#qt-in")).toHaveValue(
        "Which of these changes apply to open-weight models?",
      );
      // leaving the thread asks too
      await p.getByRole("button", { name: "Home" }).first().click();
      await expect(d).toBeVisible();
      await d.getByRole("button", { name: "Discard" }).click();
      await expect(p).toHaveURL(/\/$/);
    },
  },
  {
    key: "as-fu-fail",
    url: "/s/public/t/01M7HWGZJGT7JTFFVSYPX055KV",
    run: async (p) => {
      await p.locator(".p-foot").getByRole("button", { name: "Ask about this answer" }).click();
      await p.locator("#qt-in").fill("Which of these changes apply to open-weight models?");
      await p.route("**/api/sync/write", (r) => r.abort());
      await p.locator("#qt-comp").getByRole("button", { name: "Ask", exact: true }).click();
      const err = p.locator(".qt-err");
      await expect(err).toContainText("Couldn’t post. Try again.");
      await p.unroute("**/api/sync/write");
      await err.getByRole("button", { name: "Retry" }).click();
      await expect(p.locator("#qt-comp")).toHaveCount(0);
      await text(p, "Which of these changes apply to open-weight models?");
    },
  },
  {
    key: "as-post-fail",
    url: "/s/public",
    run: async (p) => {
      await p.getByRole("button", { name: /Make a query/ }).click();
      await p.locator(".c2-mode").getByRole("button", { name: "Post" }).click();
      await p
        .locator("#compose-text")
        .fill("Notes from Thursday’s reading group are on the wiki page.");
      await p.route("**/api/sync/write", (r) => r.abort());
      await p.locator(".c2-end").getByRole("button", { name: "Post" }).click();
      const err = p.locator(".as-perr");
      await expect(err).toContainText("Couldn’t post. Try again.");
      await expect(p.locator("#compose-text")).toHaveValue(
        "Notes from Thursday’s reading group are on the wiki page.",
      );
      await p.unroute("**/api/sync/write");
      await err.getByRole("button", { name: "Retry" }).click();
      await expect(p.locator("#compose-text")).toHaveCount(0);
    },
  },
  {
    // phase 2 review round 1, finding 2: the first post applied but its
    // answer was lost; the person edits the text and posts again
    key: "as-post-lost",
    url: "/s/public",
    run: async (p) => {
      const first =
        "Notes from Thursday’s reading group are on the wiki page. Next week: chapters 4 to 6.";
      const edited =
        "Notes from Thursday’s reading group are on the wiki page. Next week: chapters 4 to 7.";
      await p.getByRole("button", { name: /Make a query/ }).click();
      await p.locator(".c2-mode").getByRole("button", { name: "Post" }).click();
      await p.locator("#compose-text").fill(first);
      let lose = true;
      await p.route("**/api/sync/write", async (r) => {
        if (!lose) return r.continue();
        lose = false;
        // the server applies it; the browser never sees the answer
        await r.fetch();
        await r.abort("connectionreset");
      });
      const post = p.locator(".c2-end").getByRole("button", { name: "Post" });
      await post.click();
      await expect(p.locator(".as-perr")).toContainText("Couldn’t post. Try again.");
      await p.locator("#compose-text").fill(edited);
      // the check reads the space first: hold that read to see it
      let release = () => undefined as void;
      const held = new Promise<void>((r) => (release = r));
      await p.route("**/api/sync/pull", async (r) => {
        await held;
        await r.continue();
      });
      await post.click();
      await expect(p.locator(".as-pchk")).toHaveText("Checking whether your post went through…");
      await expect(post).toBeDisabled();
      release();
      await expect(p).toHaveURL(/\/t\//);
      await toastSays(
        p,
        "Your post went through before the error, so Session didn’t post it again. Your later edits weren’t saved.",
      );
      await p.locator(".cs-toast").getByRole("button", { name: "Copy your edits" }).click();
      await toastSays(p, "Copied your edits.");
      await p.unroute("**/api/sync/pull");
      await expect(p.getByText(first).first()).toBeVisible();
      await p.goto("/s/public");
      await expect(p.getByText(/chapters 4 to 6/)).toHaveCount(1);
      await expect(p.getByText(/chapters 4 to 7/)).toHaveCount(0);
    },
  },
  {
    // the first post never reached the server: Post again sends the same
    // create with the edited text, once
    key: "as-post-check",
    url: "/s/public",
    run: async (p) => {
      await p.getByRole("button", { name: /Make a query/ }).click();
      await p.locator(".c2-mode").getByRole("button", { name: "Post" }).click();
      await p.locator("#compose-text").fill("A reading list for chapters 4 to 6.");
      await p.route("**/api/sync/write", (r) => r.abort());
      const post = p.locator(".c2-end").getByRole("button", { name: "Post" });
      await post.click();
      await expect(p.locator(".as-perr")).toContainText("Couldn’t post. Try again.");
      await p.unroute("**/api/sync/write");
      await p.locator("#compose-text").fill("A reading list for chapters 4 to 7.");
      // still the lost create's note while the text changes
      await expect(p.locator(".as-perr")).toContainText("Couldn’t post. Try again.");
      await post.click();
      await expect(p).toHaveURL(/\/t\//);
      await expect(p.getByText("A reading list for chapters 4 to 7.").first()).toBeVisible();
      await expect(p.locator(".cs-toast")).toHaveCount(0);
      await p.goto("/s/public");
      await expect(p.getByText(/A reading list for chapters/)).toHaveCount(1);
    },
  },
  {
    key: "ov-compose-back",
    scenario: "replication: member",
    url: "/s/replication-club",
    run: async (p) => {
      await p.getByRole("button", { name: /Make a query/ }).click();
      await p.locator("#compose-text").fill("A draft");
      await p.getByRole("button", { name: "Home" }).first().click();
      const d = p.getByRole("alertdialog", { name: "Discard this draft?" });
      await expect(d).toBeVisible();
      await d.getByRole("button", { name: "Keep editing" }).click();
      await expect(p.locator("#compose-text")).toHaveValue("A draft");
      await expect(p).toHaveURL(/\/s\/replication-club$/);
    },
  },
  {
    key: "ta-reply",
    scenario: "threads: your post with replies",
    url: "/s/public/t/:thread",
    thread: myPost("public"),
    run: async (p) => {
      const top = p.locator(".th-rps > .rp").first();
      await top
        .locator(".rp-acts")
        .getByRole("button", { name: "Reply", exact: true })
        .first()
        .click();
      await p.locator("#ta-rp").fill("Room 2B is on the second floor, next to the library.");
      await p.locator(".ta-rpbox").getByRole("button", { name: "Reply" }).click();
      await expect(p.locator(".ta-rpbox")).toHaveCount(0);
      await text(p, "Room 2B is on the second floor, next to the library.");
      // a reply to the post
      await p.locator("#fu-input").fill("Thanks, see you there.");
      await p.locator(".fu-box2").getByRole("button", { name: "Reply" }).click();
      await text(p, "Thanks, see you there.");
      await expect(p.locator("#fu-input")).toHaveValue("");
    },
  },
  {
    key: "ta-del-reply",
    scenario: "threads: your post with replies",
    url: "/s/public/t/:thread",
    thread: myPost("public"),
    run: async (p) => {
      await p.locator(".p-foot").getByRole("button", { name: "More actions" }).click();
      await p.getByRole("menuitem", { name: "Delete" }).click();
      const d = p.getByRole("alertdialog", { name: "Delete your post?" });
      await d.getByRole("button", { name: "Delete" }).click();
      await text(p, "You deleted this post.");
    },
  },
  {
    key: "cx-im-mod",
    scenario: "sablefield: an open space to moderate",
    url: "/s/sablefield/t/:thread",
    thread: postWithReply("sablefield"),
    run: async (p) => {
      const reply = p.locator(".th-rps .rp").first();
      await reply.getByRole("button", { name: "More actions" }).click();
      await p.getByRole("menuitem", { name: "Hide" }).click();
      await toastSays(p, "Hidden. People see “This reply is hidden by a moderator.”");
      await expect(p.getByText("This reply is hidden by a moderator.").first()).toBeVisible();
      await p.getByRole("button", { name: "Show it again" }).first().click();
      await expect(p.getByText("This reply is hidden by a moderator.")).toHaveCount(0);
    },
  },
  {
    key: "as-run",
    scenario: "asks: your ask",
    args: { space: "public", end: "running" },
    url: "/s/public/t/01M7HWS780000000000000000B",
    run: async (p) => {
      await expect(p.getByText("Researching").first()).toBeVisible();
      await p.getByRole("button", { name: "Stop" }).click();
      await text(p, /Stopped\./);
      await p.getByRole("button", { name: "Run again" }).click();
      await expect(p.getByText("Researching").first()).toBeVisible();
    },
  },
  {
    key: "sx-ax-gone",
    scenario: "replication: removed",
    url: "/",
    run: async (p) => {
      await expect(p.getByRole("heading", { name: "Home" })).toBeVisible();
      await expect(p.locator(".hnav").getByText("#replication-club")).toHaveCount(0);
    },
  },
  {
    key: "sx-ax-demoted",
    scenario: "replication: moderator role removed",
    url: "/s/replication-club",
    run: async (p) => {
      await expect(p.getByRole("button", { name: "Joined" })).toBeVisible();
      await expect(p.getByRole("button", { name: "Manage #replication-club" })).toHaveCount(0);
    },
  },
];

async function open(p: Page, s: Screen) {
  const { records } = await loadScenario(p.context().request, s.scenario ?? "seed", {
    args: s.args,
    ...(s.edit ? { edit: s.edit } : {}),
  });
  if (!s.out) await signInAs(p.context());
  const th = s.thread?.(records);
  if (s.thread && !th) throw new Error(`${s.key}: no such thread in the scenario`);
  const url = th ? s.url.replace(":thread", String(th.record["id"])) : s.url;
  await p.goto(pathFor(records, `session.app${url}`));
}

for (const [layout, viewport] of [
  ["Desktop", { width: 1318, height: 900 }],
  ["Mobile Web", { width: 390, height: 844 }],
] as const) {
  test.describe(`slice 2 screens, ${layout}`, () => {
    test.use({ viewport });
    for (const s of SCREENS) {
      test(`${s.key}`, async ({ page }) => {
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(e.message));
        await open(page, s);
        await s.run(page);
        expect(errors).toEqual([]);
      });
    }
  });
}

test.describe("invite links", () => {
  test("nm-invite and nm-expired: a live link joins, a used one says it expired", async ({
    page,
  }) => {
    // the links of #replication-club as its moderators see them, in the seed,
    // where the person is not a member
    const mod = await recordsOf("replication: moderator");
    const links = mod.records.filter((r) => r.record.kind === "invite");
    const live = links.find((l) => l.record["dead"] === null && l.record["expiresAt"] !== null);
    const used = links.find((l) => l.record["dead"] !== null);
    expect(live && used).toBeTruthy();
    await loadScenario(page.context().request, "seed", { edit: (rs) => [...rs, ...links] });
    await signInAs(page.context());
    await page.goto(`/i/${String(used?.record["code"])}`);
    await expect(page.getByRole("heading", { name: "This invite link has expired" })).toBeVisible();
    await page.goto(`/i/${String(live?.record["code"])}`);
    await expect(page.getByText("invited you to join")).toBeVisible();
    await page.getByRole("button", { name: "Accept invite" }).click();
    await expect(
      page.locator(".cs-toast").getByText("You joined #replication-club."),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/s\/replication-club$/);
    await expect(page.getByRole("button", { name: "Joined" })).toBeVisible();
  });
});

// Refused writes on the web (phase 2 review round 1, finding 3): a STALE or
// FORBIDDEN decision shows a toast with no action, the item shows its
// current state, and nothing is applied (AGENTS.md; the mockup's
// sx-rf-show, sx-rf-approve and sx-rf-forbidden). The page's event stream is
// held, so it has not heard of the change the server made meanwhile.
const TEST_HEADERS = { "x-requested-with": "session", "content-type": "application/json" };

/** Write records on the server as they are now (`/api/test/records`): each
 * put moves the record's rev. */
async function serverPut(p: Page, records: KeyedRecord[]) {
  const r = await p.request.post(`${APP_ORIGIN}/api/test/records`, {
    headers: TEST_HEADERS,
    data: {
      records: records.map((x) => ({ key: x.key, record: { ...x.record, rev: undefined } })),
    },
  });
  expect(r.ok()).toBe(true);
}

/** The toast says `text` and offers nothing but Dismiss. */
async function toastWithoutAction(p: Page, text: string) {
  const t = p.locator(".cs-toast");
  await expect(t.getByText(text, { exact: true })).toBeVisible();
  await expect(t.getByRole("button")).toHaveCount(1);
  await expect(t.getByRole("button", { name: "Dismiss" })).toBeVisible();
}

for (const [layout, viewport] of [
  ["Desktop", { width: 1318, height: 900 }],
  ["Mobile Web", { width: 390, height: 844 }],
] as const) {
  test.describe(`refused writes, ${layout}`, () => {
    test.use({ viewport });

    test("sx-rf-approve: Approve refused as STALE is not reapplied", async ({ page: p }) => {
      const { records } = await loadScenario(p.context().request, "replication: moderator", {
        args: { seen: true },
      });
      await signInAs(p.context());
      await p.route("**/api/sync/events**", () => undefined);
      await p.goto("/s/replication-club/manage/requests");
      const card = p.locator(".rq-card").first();
      const who = ((await card.locator(".rq-nm .faint").textContent()) ?? "")
        .replace(/^@/, "")
        .trim();
      const req = records.find((r) => r.record.kind === "request" && r.record["u"] === who);
      expect(req).toBeTruthy();
      // the person rewrites the request after the moderator looked
      const msg = "Edited after the moderator opened the queue.";
      const a = (req?.record["a"] as string[] | undefined) ?? [];
      if (req) await serverPut(p, [{ ...req, record: { ...req.record, a: [msg, ...a.slice(1)] } }]);
      await card.getByRole("button", { name: "Approve" }).click();
      await dialog(p, `Approve the request from ${who}?`)
        .getByRole("button", { name: "Approve" })
        .click();
      await toastWithoutAction(
        p,
        `Approve wasn’t applied because ${who} changed the request after you chose Approve.`,
      );
      // the card shows the request as it is now, still open
      const now = p.locator(".rq-card").filter({ hasText: who });
      await expect(now.getByText(msg)).toBeVisible();
      await expect(now.getByRole("button", { name: "Approve" })).toBeVisible();
      await expect(p.locator(".rq-decided").getByText(who)).toHaveCount(0);
    });

    test("Undo of a decline refused as STALE is not sent again", async ({ page: p }) => {
      const { records } = await loadScenario(p.context().request, "replication: moderator", {
        args: { seen: true },
      });
      await signInAs(p.context());
      // this page does not hear of changes others make
      await p.route("**/api/sync/events**", () => undefined);
      await p.goto("/s/replication-club/manage/requests");
      const card = p.locator(".rq-card").first();
      const who = ((await card.locator(".rq-nm .faint").textContent()) ?? "")
        .replace(/^@/, "")
        .trim();
      await card.getByRole("button", { name: "Decline" }).click();
      await dialog(p, `Decline the request from ${who}?`)
        .getByRole("button", { name: "Decline" })
        .click();
      await toastSays(p, `Declined ${who}.`);
      // another moderator approves it meanwhile
      const req = records.find((r) => r.record.kind === "request" && r.record["u"] === who);
      expect(req).toBeTruthy();
      if (req) await serverPut(p, [{ ...req, record: { ...req.record, st: "approved" } }]);
      const writes: string[] = [];
      p.on("request", (r) => {
        if (r.url().endsWith("/api/sync/write")) writes.push(r.postData() ?? "");
      });
      await p.locator(".cs-toast").getByRole("button", { name: "Undo" }).click();
      await toastWithoutAction(
        p,
        "This item changed after you opened it, so the server didn’t apply the change. Session undid it.",
      );
      // one Undo was sent, not a second one with the new rev
      expect(writes.filter((w) => w.includes("reopen"))).toHaveLength(1);
      await expect(p.locator(".rq-card .rq-nm .faint").getByText(who, { exact: true })).toHaveCount(
        0,
      );
    });

    test("sx-rf-show: Show refused as STALE is not reapplied", async ({ page: p }) => {
      const { records } = await loadScenario(
        p.context().request,
        "sablefield: bram edited a hidden reply",
      );
      await signInAs(p.context());
      const hide = records.find((r) => r.record.kind === "hide");
      const reply = records.find((r) => r.key === hide?.record["item"]);
      expect(hide && reply).toBeTruthy();
      await p.route("**/api/sync/events**", () => undefined);
      await p.goto(`/s/sablefield/t/${String(reply?.record["th"])}`);
      const note = p
        .locator(".sf-modph")
        .filter({ hasText: "This reply is hidden by a moderator." });
      await expect(note).toBeVisible();
      // bram edits the hidden reply meanwhile: its hide record moves
      if (hide && reply)
        await serverPut(p, [
          { ...reply, record: { ...reply.record, t: "Edited again while the page was open." } },
          { ...hide, record: { ...hide.record, ed: 1 } },
        ]);
      await note.getByRole("button", { name: "Show it again" }).click();
      await toastWithoutAction(
        p,
        "Show wasn’t applied because bram edited the reply after you chose Show.",
      );
      // still hidden
      await expect(note).toBeVisible();
      await expect(note.getByRole("button", { name: "Show it again" })).toBeVisible();
    });

    test("sx-rf-forbidden: a moderation write refused as FORBIDDEN is not reapplied", async ({
      page: p,
    }) => {
      const { records } = await loadScenario(p.context().request, "replication: moderator", {
        args: { seen: true },
      });
      await signInAs(p.context());
      await p.route("**/api/sync/events**", () => undefined);
      await p.goto("/s/replication-club/manage/requests");
      const card = p.locator(".rq-card").first();
      const who = ((await card.locator(".rq-nm .faint").textContent()) ?? "")
        .replace(/^@/, "")
        .trim();
      // the person's moderator role is taken away meanwhile
      const me = records.find(
        (r) =>
          r.record.kind === "member" &&
          r.record["u"] === "ines.v" &&
          r.key.includes(":ines.v") &&
          records.some(
            (x) =>
              x.record.kind === "space" &&
              x.record["name"] === "replication-club" &&
              x.record["id"] === r.record["sp"],
          ),
      );
      expect(me).toBeTruthy();
      if (me) await serverPut(p, [{ ...me, record: { ...me.record, role: "member" } }]);
      await card.getByRole("button", { name: "Approve" }).click();
      await dialog(p, `Approve the request from ${who}?`)
        .getByRole("button", { name: "Approve" })
        .click();
      await toastWithoutAction(
        p,
        "You no longer have permission to do this. Session undid the change.",
      );
      await expect(p.locator(".rq-decided").getByText(who)).toHaveCount(0);
    });
  });
}
