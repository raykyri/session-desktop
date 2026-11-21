// Notifications, the member list, channel invite links and frozen channels
// on the fixture replica (02 W2.6, W6.8-W6.10; 04 B2, B4, B6, O4): the text
// of each notification kind and of a coalesced one, the summary line, the
// unread dot through Mark all as read, a row opening its thread with the
// item selected, a notification about a private channel the viewer left;
// the menu items an owner and a member see in the member list, the Banned
// list; the invite link dialog's create, copy, revoke and undo; the frozen
// channel's banner, composer and controls.

import type { NotifRec, StoredRecord } from "@session/mutators";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import test from "ava";

import { channelInviteLink } from "../src/features/channels/InviteLinksDialog.js";
import { memberActions, memberOrder } from "../src/features/channels/MembersDialog.js";
import {
  notifText,
  unreadLine,
  type NotifRow,
} from "../src/features/notifications/notifications.js";
import { currentToast } from "../src/features/shell/Toast.js";
import { configureReplica } from "../src/replica/ReplicaProvider.js";
import { fixtureReplicaConfig, type FixtureReplica } from "../src/replica/fixtureReplica.js";
import { channelByName } from "../src/replica/queries.js";
import type { WriteOutcome } from "../src/replica/source.js";
import { useDraftsStore } from "../src/stores/drafts.js";
import { useThreadUiStore } from "../src/stores/threadUi.js";

import { renderApp, waitUntil } from "./helpers.js";

let made: FixtureReplica[] = [];
let prepare: (replica: FixtureReplica) => void = () => {};

test.beforeEach(() => {
  made = [];
  prepare = () => {};
  configureReplica({
    ...fixtureReplicaConfig({ runMs: null }),
    create: (viewer) => {
      const replica = fixtureReplicaConfig({ runMs: null }).create(viewer) as FixtureReplica;
      prepare(replica);
      made.push(replica);
      return replica;
    },
  });
  useDraftsStore.setState({ byKey: {}, hidden: false });
  useThreadUiStore.getState().reset();
});
test.afterEach.always(() => {
  cleanup();
  for (const r of made) r.dispose();
  configureReplica(null);
});

const replicaOf = () => {
  const replica = made[made.length - 1];
  if (!replica) throw new Error("no replica");
  return replica;
};

const rewrite = (replica: FixtureReplica, record: StoredRecord, change: Record<string, unknown>) =>
  replica.write([{ ...record, ...change }]);

function space(replica: FixtureReplica, name: string) {
  const s = channelByName(replica, name);
  if (!s) throw new Error(`no #${name}`);
  const rec = replica.raw(`space:${s.id}`);
  if (!rec) throw new Error(`no record of #${name}`);
  return rec;
}

/** Records every write the app makes, answering each with `answer`. */
function recordWrites(
  replica: FixtureReplica,
  answer: (name: string, input: unknown) => WriteOutcome | null = () => null,
) {
  const calls: [string, unknown][] = [];
  const mutate = replica.mutate.bind(replica);
  replica.mutate = async (name, input) => {
    calls.push([name, input]);
    return answer(name, input) ?? mutate(name, input);
  };
  return calls;
}

const row = (type: NotifRec["type"]) =>
  document.querySelector<HTMLElement>(`.nrow[data-notif="${type}"]`);
const rowsOf = (type: NotifRec["type"]) =>
  [...document.querySelectorAll<HTMLElement>(`.nrow[data-notif="${type}"]`)].map(
    (r) => r.querySelector(".ntx")?.textContent ?? "",
  );

// ---------------------------------------------------------- notifications

const base: NotifRow = {
  id: "n",
  type: "reply",
  read: false,
  createdAt: "2026-11-16T10:00:00Z",
  actor: "lettie",
  others: 0,
  title: "A post",
  where: "post",
  what: "ask",
  reason: null,
  code: null,
  channel: "ml",
  target: null,
};

test("the text of each notification kind, and of a coalesced one", (t) => {
  t.is(
    notifText({ ...base, type: "mention", where: "reply" }),
    "@lettie mentioned you in a reply on “A post”",
  );
  t.is(
    notifText({ ...base, type: "mention", where: "comment" }),
    "@lettie mentioned you in a comment on “A post”",
  );
  t.is(notifText({ ...base, type: "mention" }), "@lettie mentioned you in a post on “A post”");
  t.is(notifText(base), "@lettie replied to your post “A post”");
  t.is(notifText({ ...base, type: "branch" }), "@lettie branched from your ask “A post”");
  t.is(notifText({ ...base, type: "comment" }), "@lettie commented on your ask “A post”");
  t.is(
    notifText({ ...base, type: "removed", actor: "olga", reason: "Off topic" }),
    "@olga removed your ask: “Off topic”",
  );
  t.is(
    notifText({ ...base, type: "removed", actor: "olga", what: "post" }),
    "@olga removed your post",
  );
  t.is(
    notifText({ ...base, type: "invite_used", actor: "priya.n", code: "SESS-9TQ2-X8" }),
    "@priya.n joined Session with your invite SESS-9TQ2-X8",
  );
  t.is(notifText({ ...base, others: 1 }), "@lettie and 1 other replied to your post “A post”");
  t.is(notifText({ ...base, others: 3 }), "@lettie and 3 others replied to your post “A post”");
  t.is(notifText({ ...base, title: null }), "@lettie replied to your post a deleted thread");
});

test("the summary line for 0, 1 and 3 unread", (t) => {
  t.is(unreadLine(0), "All caught up.");
  t.is(unreadLine(1), "1 unread notification.");
  t.is(unreadLine(3), "3 unread notifications.");
});

test.serial("the page lists every kind, newest first, with the summary line", async (t) => {
  await renderApp("/notifications");
  await screen.findByRole("heading", { name: "Notifications" });
  await waitUntil(t, () => row("mention") !== null, "the rows render");
  t.truthy(screen.getByText(/^3 unread notifications\. Mentions, replies to your posts/));
  t.regex(rowsOf("mention")[0] ?? "", /^@jun\.park mentioned you in a reply on “.+”#ml-papers · /);
  t.regex(rowsOf("branch")[0] ?? "", /^@hal_b branched from your ask “.+”#public · /);
  t.regex(
    rowsOf("removed")[0] ?? "",
    /^@mira_k removed your ask: “Duplicate of the Nov 12 thread on the same paper\. Please continue there\.”#replication-club · /,
  );
  t.regex(rowsOf("reply")[0] ?? "", /^@lettie replied to your post “.+”#ml-papers · /);
  t.regex(rowsOf("comment")[0] ?? "", /^@mira_k commented on your ask “.+”#sci-fi · /);
  t.regex(rowsOf("invite_used")[0] ?? "", /^@priya\.n joined Session with your inviteInvites · /);
  // unread rows are tinted and carry the dot
  const mention = row("mention") as HTMLElement;
  t.true(mention.classList.contains("unread"));
  t.truthy(within(mention).getByRole("img", { name: "Unread" }));
  t.is(within(row("invite_used") as HTMLElement).queryByRole("img", { name: "Unread" }), null);
  // newest first
  const times = [...document.querySelectorAll(".nrow time")].map((x) => x.getAttribute("datetime"));
  t.deepEqual(times, [...times].sort().reverse());
});

test.serial(
  "the unread dot stays when the page opens and clears after Mark all as read",
  async (t) => {
    await renderApp("/notifications");
    await waitUntil(t, () => row("mention") !== null, "the rows render");
    t.truthy(screen.getByRole("button", { name: "Account, 3 unread notifications" }));
    t.truthy(document.querySelector("[data-unread-dot]"));
    fireEvent.click(screen.getByRole("button", { name: "Mark all as read" }));
    await waitUntil(
      t,
      () => currentToast() === "All notifications marked as read.",
      "the Mark all toast",
    );
    await waitUntil(t, () => document.querySelector("[data-unread-dot]") === null, "no dot");
    t.truthy(screen.getByRole("button", { name: "Account" }));
    t.truthy(screen.getByText(/^All caught up\./));
    t.true(screen.getByRole("button", { name: "Mark all as read" }).disabled);
  },
);

test.serial(
  "opening a reply mention marks it read and opens the thread with the reply selected",
  async (t) => {
    let n: NotifRec | undefined;
    prepare = (replica) => {
      n = replica.rawAll("notif").find((x) => x.type === "mention" && !x.read);
    };
    const app = await renderApp("/notifications");
    await waitUntil(t, () => row("mention") !== null, "the rows render");
    const calls = recordWrites(replicaOf());
    fireEvent.click(row("mention") as HTMLElement);
    t.deepEqual(calls[0], ["notifications.markRead", { id: n?.id }]);
    await waitUntil(
      t,
      () => app.router.state.location.pathname === "/c/ml-papers",
      "the channel opens",
    );
    const search = app.router.state.location.search as { t?: string; sel?: string };
    t.is(search.t, n?.th ?? undefined);
    t.is(`reply:${search.sel ?? ""}`, n?.item ?? "");
    await waitUntil(
      t,
      () => screen.queryByRole("button", { name: "Account, 2 unread notifications" }) !== null,
      "one fewer unread",
    );
  },
);

test.serial("a coalesced reply reads “@x and N others”", async (t) => {
  prepare = (replica) => {
    const reply = replica.rawAll("notif").find((x) => x.type === "reply");
    if (reply) rewrite(replica, reply, { n: 3, read: false });
  };
  await renderApp("/notifications");
  await waitUntil(t, () => row("reply") !== null, "the rows render");
  t.regex(rowsOf("reply")[0] ?? "", /^@lettie and 2 others replied to your post/);
});

test.serial("a notification about a private channel the viewer left is not listed", async (t) => {
  prepare = (replica) => {
    const grants = space(replica, "grant-review");
    const at = "2026-11-16T09:59:00Z";
    replica.write([
      {
        kind: "notif",
        id: "01M7HWGZJGT7JTFFVSYPX0N0TE",
        to: "ines.v",
        type: "mention",
        sp: grants.kind === "space" ? grants.id : "",
        th: null,
        item: null,
        actor: "sol",
        n: 1,
        note: null,
        read: false,
        createdAt: at,
      },
    ]);
    replica.write([], [`member:${grants.kind === "space" ? grants.id : ""}:ines.v`]);
  };
  await renderApp("/notifications");
  await waitUntil(t, () => row("mention") !== null, "the rows render");
  t.is(rowsOf("mention").filter((x) => x.startsWith("@sol")).length, 0);
});

test.serial("no notifications: the empty state with Invite someone", async (t) => {
  prepare = (replica) =>
    replica.write(
      [],
      replica.rawAll("notif").map((n) => `notif:${n.id}`),
    );
  await renderApp("/notifications");
  t.truthy(await screen.findByRole("heading", { name: "No notifications yet" }));
  t.truthy(screen.getByRole("link", { name: "Invite someone" }));
  t.is(screen.queryByText(/unread notification|All caught up/), null);
});

// ------------------------------------------------------------ member list

test("the member list's order and each viewer's menu items", (t) => {
  const m = (u: string, role: "owner" | "member", joinedAt: string) =>
    ({ kind: "member", sp: "s", u, role, adm: u, joinedAt, rev: 1 }) as const;
  t.deepEqual(
    memberOrder([
      m("b", "member", "2026-11-02T00:00:00Z"),
      m("o", "owner", "2026-11-03T00:00:00Z"),
      m("a", "member", "2026-11-01T00:00:00Z"),
    ]).map((x) => x.u),
    ["o", "a", "b"],
  );
  const open = { owned: true, private: false, name: "lounge", frozen: false };
  t.deepEqual(memberActions(open, m("a", "member", ""), "o"), ["Ban from #lounge"]);
  t.deepEqual(memberActions({ ...open, private: true }, m("a", "member", ""), "o"), [
    "Ban from #lounge",
    "Remove from channel",
  ]);
  // nobody acts on the owner, nor on themselves; a member has no menu
  t.deepEqual(memberActions(open, m("o", "owner", ""), "o"), []);
  t.deepEqual(memberActions({ ...open, owned: false }, m("b", "member", ""), "a"), []);
});

async function openMembers(path: string, name: string) {
  await renderApp(path);
  fireEvent.click(await screen.findByRole("button", { name: "About this channel" }));
  const info = await screen.findByRole("dialog", { name: new RegExp(`^#${name}`) });
  fireEvent.click(within(info).getByRole("button", { name: /^Members, \d+$/ }));
  return screen.findByRole("dialog", { name: `Members of #${name}` });
}

test.serial(
  "the owner's member list: Ban on others, none on themselves; Banned with Unban",
  async (t) => {
    prepare = (replica) => {
      const s = space(replica, "sci-fi");
      const sp = s.kind === "space" ? s.id : "";
      replica.write([
        { kind: "ban", id: `${sp}:spammer`, sp, u: "spammer", createdAt: "2026-11-15T10:00:00Z" },
      ]);
    };
    const dialog = await openMembers("/c/sci-fi", "sci-fi");
    const list = within(dialog).getByRole("list", { name: "Members" });
    const rows = within(list).getAllByRole("listitem");
    t.is(rows[0]?.getAttribute("data-member"), "ines.v");
    t.truthy(within(rows[0] as HTMLElement).getByText("Owner"));
    t.is(within(rows[0] as HTMLElement).queryByRole("button", { name: "More" }), null);
    const other = rows[1] as HTMLElement;
    fireEvent.click(within(other).getByRole("button", { name: "More" }));
    const menu = await screen.findByRole("menu");
    t.truthy(within(menu).getByRole("menuitem", { name: "Ban from #sci-fi" }));
    t.is(within(menu).queryByRole("menuitem", { name: "Remove from channel" }), null);
    fireEvent.keyDown(menu, { key: "Escape" });
    const banned = within(dialog).getByRole("list", { name: "Banned" });
    const ban = within(banned).getAllByRole("listitem")[0] as HTMLElement;
    const who = ban.getAttribute("data-banned") ?? "";
    const calls = recordWrites(replicaOf());
    fireEvent.click(within(ban).getByRole("button", { name: "Unban" }));
    t.deepEqual(calls[0]?.[0], "members.unban");
    await waitUntil(t, () => currentToast() === `Unbanned @${who}.`, "the Unban toast");
  },
);

test.serial("a member's list has no menus and no Banned list", async (t) => {
  const dialog = await openMembers("/c/public", "public");
  t.is(within(dialog).queryByRole("button", { name: "More" }), null);
  t.is(within(dialog).queryByRole("list", { name: "Banned" }), null);
});

test.serial(
  "in a private channel the owner can remove a member, with the admission id",
  async (t) => {
    prepare = (replica) => rewrite(replica, space(replica, "sci-fi"), { vis: "private" });
    const dialog = await openMembers("/c/sci-fi", "sci-fi");
    const other = within(within(dialog).getByRole("list", { name: "Members" })).getAllByRole(
      "listitem",
    )[1] as HTMLElement;
    const user = other.getAttribute("data-member") ?? "";
    const replica = replicaOf();
    const s = space(replica, "sci-fi");
    const adm = (replica.raw(`member:${s.kind === "space" ? s.id : ""}:${user}`) as { adm: string })
      .adm;
    const calls = recordWrites(replica, () => ({
      ok: false,
      error: { code: "STALE", message: "This item changed after you saw it. Look at it again." },
    }));
    fireEvent.click(within(other).getByRole("button", { name: "More" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Remove from channel" }));
    t.deepEqual(calls[0], [
      "members.remove",
      { space: s.kind === "space" ? s.id : "", user, base: { adm } },
    ]);
    // STALE: the toast says so, and the row shows the member as they are now
    await waitUntil(
      t,
      () => currentToast() === "This item changed after you saw it. Look at it again.",
      "the STALE toast",
    );
    t.truthy(document.querySelector(`[data-member="${user}"]`));
  },
);

// ------------------------------------------------------ channel invite links

test.serial("Invite to #name: create, copy, revoke and undo", async (t) => {
  prepare = (replica) => rewrite(replica, space(replica, "sci-fi"), { vis: "private" });
  const copied: string[] = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: (text: string) => (copied.push(text), Promise.resolve()) },
  });
  await renderApp("/c/sci-fi");
  fireEvent.click(await screen.findByRole("button", { name: "About this channel" }));
  const info = await screen.findByRole("dialog", { name: /^#sci-fi/ });
  fireEvent.click(within(info).getByRole("button", { name: "Invite to #sci-fi" }));
  const dialog = await screen.findByRole("dialog", { name: "Invite to #sci-fi" });
  const replica = replicaOf();
  const s = space(replica, "sci-fi");
  const sp = s.kind === "space" ? s.id : "";
  const id = "01M7HWGZJGT7JTFFVSYPX0AB12";
  const code = "k3v8q2m9x7c4b6n1p5r0t8w2ya";
  const calls = recordWrites(replica, (name, input) => {
    if (name === "invites.create") {
      replica.write([
        {
          kind: "invite",
          id,
          code,
          by: "ines.v",
          sp,
          expiresAt: "2026-11-23T10:00:00Z",
          dead: null,
          usedBy: null,
          createdAt: "2026-11-16T10:00:00Z",
        },
      ]);
      return { ok: true, result: { id: (input as { id: string }).id, code } };
    }
    return null;
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Create an invite link" }));
  t.like(calls[0]?.[1], { space: sp, days: 7 });
  await waitUntil(t, () => currentToast() === "Invite link created.", "the create toast");
  const link = await within(dialog).findByText(channelInviteLink("sci-fi", code));
  t.truthy(link);
  fireEvent.click(within(dialog).getByRole("button", { name: "Copy" }));
  await waitUntil(t, () => currentToast() === "Link copied.", "the copy toast");
  t.deepEqual(copied, [channelInviteLink("sci-fi", code)]);
  fireEvent.click(within(dialog).getByRole("button", { name: "Revoke this link" }));
  await waitUntil(t, () => calls.some(([n]) => n === "invites.revoke"), "the revoke");
  await waitUntil(
    t,
    () => within(dialog).queryByRole("button", { name: "Undo" }) !== null,
    "Undo on the revoked link",
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "Undo" }));
  await waitUntil(t, () => calls.some(([n]) => n === "invites.restore"), "the restore");
  await waitUntil(
    t,
    () => within(dialog).queryByRole("button", { name: "Copy" }) !== null,
    "the link works again",
  );
});

test.serial("an open channel's owner has no Invite to #name", async (t) => {
  await renderApp("/c/sci-fi");
  fireEvent.click(await screen.findByRole("button", { name: "About this channel" }));
  const info = await screen.findByRole("dialog", { name: "#sci-fi" });
  t.is(within(info).queryByRole("button", { name: /^Invite to/ }), null);
  t.truthy(within(info).getByRole("button", { name: "Moderation log" }));
});

// --------------------------------------------------------- frozen channels

test.serial("a frozen channel: the banner, no composer, no new replies, Delete kept", async (t) => {
  prepare = (replica) => rewrite(replica, space(replica, "public"), { frozen: true });
  await renderApp("/c/public");
  const banner = await screen.findByText(
    "#public is frozen: its owner’s account is not active. You can read it and delete your own posts.",
  );
  t.truthy(banner);
  t.is(screen.queryByRole("textbox", { name: "Ask or post" }), null);
  const follow = document.querySelector<HTMLButtonElement>(".tcard .rcount");
  t.true(follow?.disabled ?? false);
  t.is(follow?.title, "#public is frozen");
  fireEvent.click(screen.getByRole("button", { name: "About this channel" }));
  const info = await screen.findByRole("dialog", { name: "#public" });
  t.truthy(within(info).getByText("Deleted account"));
  t.truthy(within(info).getByText(/^#public is frozen:/));
});

test.serial("a frozen channel is left out of the composer's channel picker", async (t) => {
  prepare = (replica) => rewrite(replica, space(replica, "public"), { frozen: true });
  await renderApp("/");
  fireEvent.click(await screen.findByTitle("Channel"));
  t.truthy(await screen.findByRole("menuitemradio", { name: /#sci-fi/ }));
  t.is(screen.queryByRole("menuitemradio", { name: /#public/ }), null);
});
