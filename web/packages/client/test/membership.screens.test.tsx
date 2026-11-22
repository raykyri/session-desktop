// Notifications, the member list, channel invite links and frozen channels
// on the fixture replica (02 W2.6, W6.8-W6.10; 04 B2, B4, B6, O4): the text
// of each notification kind and of a coalesced one, the summary line, the
// unread dot through Mark all as read, a row opening its thread with the
// item selected, a notification about a private channel the viewer left;
// the menu items an owner and a member see in the member list, the Banned
// list; the invite link dialog's create, copy, revoke and undo; the frozen
// channel's banner, composer and controls.

import { frozenMessage, msToIso, type NotifRec, type StoredRecord } from "@session/mutators";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import test, { type ExecutionContext } from "ava";

import { safeReturn } from "../src/features/auth/AuthDialog.js";
import { useAuthDialog } from "../src/features/auth/authDialog.js";
import { channelInviteLink } from "../src/features/channels/InviteLinksDialog.js";
import { memberActions, memberOrder } from "../src/features/channels/MembersDialog.js";
import { LINK_UNUSABLE, linkJoinMessage } from "../src/features/channels/useChannelInvite.js";
import {
  notifText,
  notificationsOf,
  unloadedThreads,
  unreadLine,
  type NotifRow,
} from "../src/features/notifications/notifications.js";
import { clearToast, currentToast } from "../src/features/shell/Toast.js";
import { COPY_FAILED } from "../src/lib/clipboard.js";
import {
  CHANNEL_INVITE_KEY,
  CHANNEL_INVITE_TTL_MS,
  clearPendingInvite,
  readPendingInvite,
  restoreChannelInvite,
  savePendingInvite,
} from "../src/lib/pendingInvite.js";
import { configureReplica } from "../src/replica/ReplicaProvider.js";
import { FIXTURE_MEMBER } from "../src/replica/fixtureData.js";
import {
  createFixtureReplica,
  fixtureReplicaConfig,
  type FixtureReplica,
} from "../src/replica/fixtureReplica.js";
import { channelByName, channelsOf } from "../src/replica/queries.js";
import {
  UNKNOWN,
  type ReplicaSource,
  type UnsentWrite,
  type WriteOutcome,
} from "../src/replica/source.js";
import { useDraftsStore } from "../src/stores/drafts.js";
import { useNavigationStore } from "../src/stores/navigation.js";
import { useThreadUiStore } from "../src/stores/threadUi.js";

import { renderApp, waitUntil, waitingTestUser } from "./helpers.js";

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
  clearPendingInvite();
  clearToast();
  sessionStorage.clear();
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
  others: false,
  title: "A post",
  where: "post",
  what: "ask",
  reason: null,
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
  // the thread's record is not held: the kind is not guessed
  t.is(
    notifText({ ...base, type: "removed", actor: "olga", what: null, reason: "Off topic" }),
    "@olga removed your thread: “Off topic”",
  );
  t.is(
    notifText({ ...base, type: "invite_used", actor: "priya.n" }),
    "@priya.n joined Session with your invite",
  );
  // an actor whose account was deleted
  t.is(notifText({ ...base, actor: null }), "Deleted account replied to your post “A post”");
  // `n` counts writes, not people: a coalesced row names no number
  t.is(notifText({ ...base, others: true }), "@lettie and others replied to your post “A post”");
  // a thread without text, and one not loaded, are quoted as the mock does
  t.is(notifText({ ...base, title: null }), "@lettie replied to your post “a deleted thread”");
  t.is(notifText({ ...base, title: undefined }), "@lettie replied to your post “a thread”");
  t.is(
    notifText({ ...base, type: "branch", title: undefined }),
    "@lettie branched from your ask “a thread”",
  );
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
    t.true(screen.getByRole("button", { name: "Mark all as read" }).hasAttribute("disabled"));
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

test.serial(
  "a row whose thread is gone stays on the page and says the thread is not available",
  async (t) => {
    // a reply notification on a thread that was erased since: the channel's
    // log is loaded and holds no record of it
    const gone = "01M7HWGZJGT7JTFFVSYPX0GN01";
    let n: NotifRec | undefined;
    prepare = (replica) => {
      const reply = replica.rawAll("notif").find((x) => x.type === "reply");
      if (!reply) throw new Error("no reply notification in the fixtures");
      n = { ...reply, th: gone, item: null, read: false };
      replica.write([n]);
    };
    const app = await renderApp("/notifications");
    await waitUntil(t, () => rowsOf("reply").some((x) => x.includes("a deleted thread")), "row");
    const calls = recordWrites(replicaOf());
    const rowEl = [...document.querySelectorAll<HTMLElement>('.nrow[data-notif="reply"]')].find(
      (r) => r.textContent?.includes("a deleted thread"),
    );
    fireEvent.click(rowEl as HTMLElement);
    t.deepEqual(calls[0], ["notifications.markRead", { id: n?.id }]);
    await waitUntil(t, () => currentToast() === "This thread is not available.", "the toast");
    t.is(app.router.state.location.pathname, "/notifications");
  },
);

test.serial("a coalesced reply reads “@x and others”, a single one names only @x", async (t) => {
  prepare = (replica) => {
    const reply = replica.rawAll("notif").find((x) => x.type === "reply");
    if (reply) rewrite(replica, reply, { n: 3, read: false });
    const branch = replica.rawAll("notif").find((x) => x.type === "branch");
    if (branch) rewrite(replica, branch, { n: 1 });
  };
  await renderApp("/notifications");
  await waitUntil(t, () => row("reply") !== null, "the rows render");
  t.regex(rowsOf("reply")[0] ?? "", /^@lettie and others replied to your post “/);
  t.regex(rowsOf("branch")[0] ?? "", /^@hal_b branched from your ask “/);
});

test.serial("an invite_used row shows no code and opens Invites", async (t) => {
  prepare = (replica) => {
    const used = replica.rawAll("notif").find((x) => x.type === "invite_used");
    if (used) rewrite(replica, used, { note: "SESS-9TQ2-X8" });
  };
  const app = await renderApp("/notifications");
  await waitUntil(t, () => row("invite_used") !== null, "the rows render");
  t.regex(rowsOf("invite_used")[0] ?? "", /^@priya\.n joined Session with your inviteInvites · /);
  t.false((row("invite_used")?.textContent ?? "").includes("SESS-9TQ2-X8"));
  fireEvent.click(row("invite_used") as HTMLElement);
  await waitUntil(
    t,
    () => app.router.state.location.pathname === "/invites",
    "the row opens Invites",
  );
});

test("a comment notification whose comment is not loaded fetches its thread, then selects the comment's branch", (t) => {
  const replica = createFixtureReplica(FIXTURE_MEMBER, { runMs: null });
  t.teardown(() => replica.dispose());
  // a branch of a thread on Home (`feed.states.test.tsx` FIRST)
  const node = replica
    .rawAll("node")
    .find((x) => x.th === "01M7HWGZJGT7JTFFVSYPX055KV" && !x.del && x.mod === null);
  if (!node) throw new Error("no branch in the fixtures");
  const id = "01M7HWGZJGT7JTFFVSYPX0CM01";
  replica.write([
    {
      kind: "comment",
      id,
      th: node.th,
      s: node.s,
      node: node.id,
      parent: null,
      u: "mira_k",
      t: "A comment on the branch",
      edited: false,
      del: false,
      mod: null,
      createdAt: "2026-11-16T09:58:00Z",
    },
    {
      kind: "notif",
      id: "01M7HWGZJGT7JTFFVSYPX0CM02",
      to: FIXTURE_MEMBER,
      type: "comment",
      sp: node.s,
      th: node.th,
      item: `comment:${id}`,
      actor: "mira_k",
      n: 1,
      note: null,
      read: false,
      createdAt: "2026-11-16T09:58:00Z",
    },
  ]);
  // a view of the replica that has not loaded the comment
  const hidden = new Set([`comment:${id}`]);
  const partial = {
    me: replica.me,
    get: (key: string) => (hidden.has(key) ? UNKNOWN : replica.get(key)),
    list: replica.list.bind(replica),
  } as unknown as ReplicaSource;
  const rowOf = (source: ReplicaSource) =>
    notificationsOf(source).find((x) => x.id === "01M7HWGZJGT7JTFFVSYPX0CM02");
  const before = rowOf(partial)?.target;
  t.like(before, { kind: "thread", thread: node.th });
  t.is(before?.kind === "thread" ? before.sel : "", undefined, "no branch to select yet");
  t.true(
    unloadedThreads(partial).some((u) => u.thread === node.th),
    "its thread is fetched",
  );
  // once loaded, the row opens the branch the comment is on
  hidden.clear();
  t.like(rowOf(partial)?.target, { kind: "thread", thread: node.th, sel: node.id });
  t.false(unloadedThreads(partial).some((u) => u.thread === node.th));
});

test("a removal names its thread's kind from the record, and no kind while the replica holds none", (t) => {
  const replica = createFixtureReplica(FIXTURE_MEMBER, { runMs: null });
  t.teardown(() => replica.dispose());
  const removed = replica.all("notif").find((x) => x.type === "removed");
  if (!removed?.th) throw new Error("no removal in the fixtures");
  const key = `thread:${removed.th}`;
  const kind = (replica.raw(key) as { k: "ask" | "post" }).k;
  // the replica's answer for the removed thread's record
  let thread: "held" | "missing" | "unloaded" = "held";
  const partial = {
    me: replica.me,
    get: (k: string) =>
      k !== key || thread === "held" ? replica.get(k) : thread === "missing" ? undefined : UNKNOWN,
    list: replica.list.bind(replica),
  } as unknown as ReplicaSource;
  const text = () => {
    const row = notificationsOf(partial).find((x) => x.id === removed.id);
    return row ? notifText(row) : "";
  };
  t.regex(text(), new RegExp(` removed your ${kind}: “`));
  // not loaded, and not served (fetched and absent): neither ask nor post
  for (const state of ["unloaded", "missing"] as const) {
    thread = state;
    t.regex(text(), / removed your thread: “/, state);
  }
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
    // the owner viewing their own row: "You" then "Owner", both chips, at
    // the row's end; the menu's place is kept so the badges end where the
    // other rows' menus start
    const own = rows[0] as HTMLElement;
    t.deepEqual(
      [...own.querySelectorAll(".mlbadges > .chip")].map((c) => c.textContent),
      ["You", "Owner"],
    );
    t.is(own.querySelector(".mltext")?.textContent, "@ines.v", "no You after the handle");
    t.is(own.lastElementChild?.className, "mlmore");
    t.is(within(own).queryByRole("button", { name: "More" }), null);
    t.is((rows[1] as HTMLElement).lastElementChild?.classList.contains("more"), true);
    const other = rows[1] as HTMLElement;
    fireEvent.click(within(other).getByRole("button", { name: "More" }));
    const menu = await screen.findByRole("menu");
    t.truthy(within(menu).getByRole("menuitem", { name: "Ban from #sci-fi" }));
    t.is(within(menu).queryByRole("menuitem", { name: "Remove from channel" }), null);
    fireEvent.keyDown(menu, { key: "Escape" });
    const banned = within(dialog).getByRole("list", { name: "Banned" });
    const ban = within(banned).getAllByRole("listitem")[0] as HTMLElement;
    t.is(ban.getAttribute("data-banned"), "spammer");
    const s = space(replicaOf(), "sci-fi");
    const calls = recordWrites(replicaOf());
    fireEvent.click(within(ban).getByRole("button", { name: "Unban" }));
    t.deepEqual(calls[0], [
      "members.unban",
      { space: s.kind === "space" ? s.id : "", user: "spammer" },
    ]);
    await waitUntil(t, () => currentToast() === "Unbanned @spammer.", "the Unban toast");
  },
);

test.serial("a member's list has no menus and no Banned section", async (t) => {
  const dialog = await openMembers("/c/public", "public");
  t.is(within(dialog).queryByRole("button", { name: "More" }), null);
  // "You" is a chip at the row's end, as "Owner" on the owner's row; with no
  // menus there is no kept place
  const mine = dialog.querySelector('[data-member="ines.v"]') as HTMLElement;
  t.deepEqual(
    [...mine.querySelectorAll(".mlbadges > .chip")].map((c) => c.textContent),
    ["You"],
  );
  t.is(mine.lastElementChild?.className, "mlbadges");
  t.is(dialog.querySelector(".mlmore"), null);
  t.is(within(dialog).queryByRole("list", { name: "Banned" }), null);
  t.is(within(dialog).queryByRole("heading", { name: "Banned" }), null);
  t.is(within(dialog).queryByText(/^Nobody is banned/), null);
});

test.serial(
  "the owner's Ban asks first, naming the person and the channel; Cancel sends nothing",
  async (t) => {
    const dialog = await openMembers("/c/sci-fi", "sci-fi");
    const other = within(within(dialog).getByRole("list", { name: "Members" })).getAllByRole(
      "listitem",
    )[1] as HTMLElement;
    const user = other.getAttribute("data-member") ?? "";
    const s = space(replicaOf(), "sci-fi");
    const calls = recordWrites(replicaOf());
    const choose = async () => {
      fireEvent.click(within(other).getByRole("button", { name: "More" }));
      fireEvent.click(await screen.findByRole("menuitem", { name: "Ban from #sci-fi" }));
      return screen.findByRole("alertdialog", { name: `Ban @${user} from #sci-fi?` });
    };
    let confirm = await choose();
    t.regex(
      confirm.textContent ?? "",
      new RegExp(`@${user.replace(".", "\\.")} stops being a member of #sci-fi`),
    );
    t.is(within(confirm).queryByRole("textbox"), null, "no reason field");
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    await waitUntil(t, () => screen.queryByRole("alertdialog") === null, "Cancel closes it");
    t.deepEqual(calls, []);
    confirm = await choose();
    fireEvent.click(within(confirm).getByRole("button", { name: "Ban" }));
    await waitUntil(t, () => calls.length > 0, "the ban is sent");
    t.deepEqual(calls[0], ["members.ban", { space: s.kind === "space" ? s.id : "", user }]);
    await waitUntil(t, () => currentToast() === `Banned @${user} from #sci-fi.`, "the Ban toast");
  },
);

test.serial("Ban from a thread's menu asks first, then bans its author", async (t) => {
  let author = "";
  let id = "";
  prepare = (replica) => {
    const sp = channelByName(replica, "sci-fi");
    const thread = replica
      .rawAll("thread")
      .find((r) => r.s === sp?.id && r.u !== "ines.v" && r.u !== null && r.mod === null && !r.del);
    if (!thread?.u) throw new Error("no thread by another member");
    author = thread.u;
    id = thread.id;
  };
  await renderApp("/c/sci-fi");
  await waitUntil(t, () => document.getElementById(`card-${id}`) !== null, "the thread renders");
  const s = space(replicaOf(), "sci-fi");
  const calls = recordWrites(replicaOf());
  const card = document.getElementById(`card-${id}`) as HTMLElement;
  fireEvent.click(within(card).getByRole("button", { name: "More" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Ban from #sci-fi" }));
  const confirm = await screen.findByRole("alertdialog", {
    name: `Ban @${author} from #sci-fi?`,
  });
  t.deepEqual(calls, [], "nothing is sent before the confirmation");
  fireEvent.click(within(confirm).getByRole("button", { name: "Ban" }));
  await waitUntil(t, () => calls.length > 0, "the ban is sent");
  t.deepEqual(calls[0], ["members.ban", { space: s.kind === "space" ? s.id : "", user: author }]);
  await waitUntil(t, () => currentToast() === `Banned @${author} from #sci-fi.`, "the Ban toast");
});

test.serial("a private channel's info shows a non-member the member count as text", async (t) => {
  const fixture = createFixtureReplica(FIXTURE_MEMBER, { runMs: null });
  const locked = channelsOf(fixture).find((c) => c.private && !c.joined);
  fixture.dispose();
  if (!locked) throw new Error("no private channel the viewer is not in");
  await renderApp(`/c/${locked.name}`);
  fireEvent.click(await screen.findByRole("button", { name: "About this channel" }));
  const info = await screen.findByRole("dialog", { name: new RegExp(`^#${locked.name}`) });
  t.is(within(info).queryByRole("button", { name: /^Members/ }), null);
  const count = within(info).getByText("Members").nextElementSibling;
  t.is(count?.textContent, String(locked.members));
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
    const confirm = await screen.findByRole("alertdialog", {
      name: `Remove @${user} from #sci-fi?`,
    });
    t.deepEqual(calls, [], "nothing is sent before the confirmation");
    fireEvent.click(within(confirm).getByRole("button", { name: "Remove" }));
    await waitUntil(t, () => calls.length > 0, "the removal is sent");
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

test.serial(
  "a removal of a person who had already left says so, and a removal that acted says Removed (C12)",
  async (t) => {
    prepare = (replica) => rewrite(replica, space(replica, "sci-fi"), { vis: "private" });
    const dialog = await openMembers("/c/sci-fi", "sci-fi");
    const others = () =>
      within(within(dialog).getByRole("list", { name: "Members" })).getAllByRole("listitem");
    const replica = replicaOf();
    let removed = false;
    recordWrites(replica, (name) =>
      name === "members.remove" ? { ok: true, result: { removed } } : null,
    );
    const remove = async (row: HTMLElement) => {
      const user = row.getAttribute("data-member") ?? "";
      fireEvent.click(within(row).getByRole("button", { name: "More" }));
      fireEvent.click(await screen.findByRole("menuitem", { name: "Remove from channel" }));
      const confirm = await screen.findByRole("alertdialog", {
        name: `Remove @${user} from #sci-fi?`,
      });
      fireEvent.click(within(confirm).getByRole("button", { name: "Remove" }));
      return user;
    };
    // the server answers removed: false: the person had left before the
    // removal applied, and nothing changed
    const gone = await remove(others()[1] as HTMLElement);
    await waitUntil(
      t,
      () => currentToast() === `@${gone} had already left #sci-fi.`,
      "the already-left toast",
    );
    removed = true;
    const user = await remove(others()[1] as HTMLElement);
    await waitUntil(t, () => currentToast() === `Removed @${user} from #sci-fi.`, "the toast");
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
  fireEvent.click(within(dialog).getByRole("button", { name: /^Copy link 1, expires / }));
  await waitUntil(t, () => currentToast() === "Link copied.", "the copy toast");
  t.deepEqual(copied, [channelInviteLink("sci-fi", code)]);
  fireEvent.click(within(dialog).getByRole("button", { name: /^Revoke link 1, expires / }));
  await waitUntil(t, () => calls.some(([n]) => n === "invites.revoke"), "the revoke");
  await waitUntil(
    t,
    () => within(dialog).queryByRole("button", { name: /^Undo revoking link 1/ }) !== null,
    "Undo on the revoked link",
  );
  fireEvent.click(within(dialog).getByRole("button", { name: /^Undo revoking link 1/ }));
  await waitUntil(t, () => calls.some(([n]) => n === "invites.restore"), "the restore");
  await waitUntil(
    t,
    () => within(dialog).queryByRole("button", { name: /^Copy link 1/ }) !== null,
    "the link works again",
  );
});

test("a channel invite link is the channel's address with the code in the fragment", (t) => {
  t.is(channelInviteLink("lab", "abc", "https://x"), "https://x/c/lab#abc");
});

/** Opens "Invite to #sci-fi" with the owner's links as `links` makes them,
 * at the replica's time. */
async function openLinks(links: (now: number, sp: string) => StoredRecord[]) {
  prepare = (replica) => {
    const s = space(replica, "sci-fi");
    rewrite(replica, s, { vis: "private" });
    replica.write(links(replica.now(), s.kind === "space" ? s.id : ""));
  };
  await renderApp("/c/sci-fi");
  fireEvent.click(await screen.findByRole("button", { name: "About this channel" }));
  const info = await screen.findByRole("dialog", { name: /^#sci-fi/ });
  fireEvent.click(within(info).getByRole("button", { name: "Invite to #sci-fi" }));
  return screen.findByRole("dialog", { name: "Invite to #sci-fi" });
}

const DAY_MS = 86_400_000;
const inviteRec = (
  id: string,
  sp: string,
  expiresAt: number,
  change: { dead?: string; usedBy?: string } = {},
): StoredRecord => ({
  kind: "invite",
  id,
  code: `code-${id.slice(-4).toLowerCase()}`,
  by: "ines.v",
  sp,
  expiresAt: msToIso(expiresAt),
  dead: change.dead ?? null,
  usedBy: change.usedBy ?? null,
  createdAt: msToIso(expiresAt - 7 * DAY_MS),
  rev: 1,
});

test.serial(
  "the link list: an expired link is left out, a used one names its user, Undo only before expiry, each button names its link",
  async (t) => {
    const dialog = await openLinks((now, sp) => [
      inviteRec("01M7HWGZJGT7JTFFVSYPX0L001", sp, now + 3 * DAY_MS),
      inviteRec("01M7HWGZJGT7JTFFVSYPX0L002", sp, now + 4 * DAY_MS),
      inviteRec("01M7HWGZJGT7JTFFVSYPX0L003", sp, now + 5 * DAY_MS, {
        dead: "Used",
        usedBy: "priya.n",
      }),
      inviteRec("01M7HWGZJGT7JTFFVSYPX0L004", sp, now + 6 * DAY_MS, { dead: "Revoked" }),
      inviteRec("01M7HWGZJGT7JTFFVSYPX0L005", sp, now - DAY_MS, { dead: "Revoked" }),
      inviteRec("01M7HWGZJGT7JTFFVSYPX0L006", sp, now - DAY_MS),
    ]);
    const list = within(dialog).getByRole("list", { name: "Invite links" });
    const item = (id: string) => list.querySelector<HTMLElement>(`[data-link="${id}"]`);
    t.is(item("01M7HWGZJGT7JTFFVSYPX0L006"), null, "an expired link is not listed");
    t.is(within(list).getAllByRole("listitem").length, 5);
    const used = item("01M7HWGZJGT7JTFFVSYPX0L003") as HTMLElement;
    t.truthy(within(used).getByText("Used by @priya.n"));
    t.is(within(used).queryByRole("button"), null, "no Undo, Copy or Revoke on a used link");
    const revoked = item("01M7HWGZJGT7JTFFVSYPX0L004") as HTMLElement;
    t.truthy(within(revoked).getByRole("button", { name: /^Undo revoking link \d, expires / }));
    const lapsed = item("01M7HWGZJGT7JTFFVSYPX0L005") as HTMLElement;
    t.truthy(within(lapsed).getByText("Revoked"));
    t.is(within(lapsed).queryByRole("button"), null, "no Undo past the expiry");
    // the open links' buttons each name their own link
    const names = within(list)
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label") ?? "");
    t.is(new Set(names).size, names.length);
    t.true(names.every((n) => /^(Copy|Revoke|Undo revoking) link \d, expires \w+ \d+$/.test(n)));
  },
);

test.serial("a copy the browser refuses shows an alert", async (t) => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: () => Promise.reject(new Error("denied")) },
  });
  const exec = document.execCommand?.bind(document);
  document.execCommand = () => false;
  t.teardown(() => {
    if (exec) document.execCommand = exec;
  });
  const dialog = await openLinks((now, sp) => [
    inviteRec("01M7HWGZJGT7JTFFVSYPX0L001", sp, now + 3 * DAY_MS),
  ]);
  fireEvent.click(within(dialog).getByRole("button", { name: /^Copy link 1/ }));
  await waitUntil(t, () => currentToast() === COPY_FAILED, "the copy failure");
  t.truthy(screen.getAllByRole("alert").some((a) => a.textContent?.includes(COPY_FAILED)));
});

// ------------------------------------------- opening a channel invite link

/** An open channel the fixture viewer has not joined: its name and id. */
function unjoinedChannel(): { name: string; id: string } {
  const fixture = createFixtureReplica(FIXTURE_MEMBER, { runMs: null });
  const c = channelsOf(fixture).find((x) => !x.private && !x.joined && !x.frozen);
  fixture.dispose();
  if (!c) throw new Error("no open channel the viewer has not joined");
  return { name: c.name, id: c.id };
}

test("a refused link join: the link message for a link that does not work, the server's for a ban", (t) => {
  t.is(linkJoinMessage({ code: "NOT_FOUND", message: "No such channel." }, "lab"), LINK_UNUSABLE);
  t.is(linkJoinMessage({ code: "FORBIDDEN", message: LINK_UNUSABLE }, "lab"), LINK_UNUSABLE);
  t.is(linkJoinMessage({ code: "FORBIDDEN", message: frozenMessage("lab") }, "lab"), LINK_UNUSABLE);
  t.is(
    linkJoinMessage({ code: "FORBIDDEN", message: "You are banned from #lab." }, "lab"),
    "You are banned from #lab.",
  );
});

test.serial(
  "a member opening a channel link joins with its code, once, and the code is dropped",
  async (t) => {
    const channel = unjoinedChannel();
    let calls: [string, unknown][] = [];
    prepare = (replica) => (calls = recordWrites(replica));
    savePendingInvite({ kind: "channel", channel: channel.name, code: "k3v8q2m9" });
    await renderApp(`/c/${channel.name}`);
    await waitUntil(t, () => calls.some(([n]) => n === "spaces.join"), "the join is sent");
    t.deepEqual(
      calls.filter(([n]) => n === "spaces.join"),
      [["spaces.join", { space: channel.id, invite: "k3v8q2m9" }]],
    );
    t.is(readPendingInvite(), null, "the code is dropped once sent");
    await waitUntil(t, () => currentToast() === `Joined #${channel.name}.`, "the Joined toast");
  },
);

test.serial("a link for another channel sends no join and keeps its code", async (t) => {
  const channel = unjoinedChannel();
  let calls: [string, unknown][] = [];
  prepare = (replica) => (calls = recordWrites(replica));
  const invite = { kind: "channel", channel: "another-channel", code: "k3v8q2m9" } as const;
  savePendingInvite(invite);
  await renderApp(`/c/${channel.name}`);
  await screen.findByRole("button", { name: "About this channel" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  t.deepEqual(calls, []);
  t.deepEqual(readPendingInvite(), invite);
});

for (const [why, message, shown] of [
  ["a frozen channel", (name: string) => frozenMessage(name), () => LINK_UNUSABLE],
  ["a used link", () => LINK_UNUSABLE, () => LINK_UNUSABLE],
  [
    "a ban",
    (name: string) => `You are banned from #${name}.`,
    (name: string) => `You are banned from #${name}.`,
  ],
] as const)
  test.serial(`a link join refused for ${why} shows its message`, async (t) => {
    const channel = unjoinedChannel();
    prepare = (replica) =>
      recordWrites(replica, (name) =>
        name === "spaces.join"
          ? { ok: false, error: { code: "FORBIDDEN", message: message(channel.name) } }
          : null,
      );
    savePendingInvite({ kind: "channel", channel: channel.name, code: "k3v8q2m9" });
    await renderApp(`/c/${channel.name}`);
    await waitUntil(t, () => currentToast() === shown(channel.name), "the refusal's toast");
  });

test.serial("a link to a frozen channel shows the expired-link message (04 B5)", async (t) => {
  const channel = unjoinedChannel();
  prepare = (replica) => rewrite(replica, space(replica, channel.name), { frozen: true });
  savePendingInvite({ kind: "channel", channel: channel.name, code: "k3v8q2m9" });
  await renderApp(`/c/${channel.name}`);
  await waitUntil(t, () => currentToast() === LINK_UNUSABLE, "the expired-link message");
});

test.serial(
  "signed out: the dialog says signing in joins #name; the code waits in this tab's storage across the provider, not in the request",
  async (t) => {
    const channel = unjoinedChannel();
    const posted: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((_url: string, init: RequestInit) => {
      posted.push(typeof init.body === "string" ? init.body : "");
      return Promise.resolve(new Response(JSON.stringify({ error: "nope" }), { status: 503 }));
    }) as typeof fetch;
    t.teardown(() => {
      globalThis.fetch = realFetch;
    });
    savePendingInvite({ kind: "channel", channel: channel.name, code: "k3v8q2m9" });
    await renderApp(`/c/${channel.name}`, { user: null });
    const dialog = await screen.findByRole("dialog", { name: "Sign in to Session" });
    t.truthy(within(dialog).getByText(`Sign in to join #${channel.name}.`));
    fireEvent.click(within(dialog).getByRole("button", { name: "Sign in with GitHub" }));
    fireEvent.click(await within(dialog).findByRole("button", { name: "Continue to GitHub" }));
    await waitUntil(t, () => posted.length > 0, "the sign-in starts");
    t.deepEqual(JSON.parse(posted[0] ?? "{}"), { returnTo: `/c/${channel.name}` });
    const kept = JSON.parse(sessionStorage.getItem(CHANNEL_INVITE_KEY) ?? "null") as {
      channel: string;
      code: string;
    } | null;
    t.like(kept, { channel: channel.name, code: "k3v8q2m9" });
    // the page load back from the provider takes it out of storage
    clearPendingInvite();
    useAuthDialog.getState().close();
    t.deepEqual(restoreChannelInvite(), {
      kind: "channel",
      channel: channel.name,
      code: "k3v8q2m9",
    });
    t.is(sessionStorage.getItem(CHANNEL_INVITE_KEY), null);
    t.deepEqual(readPendingInvite(), { kind: "channel", channel: channel.name, code: "k3v8q2m9" });
  },
);

test.serial(
  "back from signing up with an account invite, a channel link waits for the profile step",
  async (t) => {
    const channel = unjoinedChannel();
    savePendingInvite({ kind: "channel", channel: channel.name, code: "k3v8q2m9" });
    await renderApp(`/c/${channel.name}`, {
      user: {
        ...waitingTestUser(),
        pendingInvite: { name: "Ines Vidal", handle: "ines.v" },
      } as never,
    });
    const dialog = await screen.findByRole("dialog", { name: "Sign in to Session" });
    t.truthy(await within(dialog).findByRole("heading", { name: "Create your account" }));
    t.is(within(dialog).queryByRole("heading", { name: "Join with invite?" }), null);
    t.deepEqual(readPendingInvite(), {
      kind: "channel",
      channel: channel.name,
      code: "k3v8q2m9",
    });
  },
);

test.serial(
  "a channel link followed by a new identity's sign-in: the account redeems a code on /welcome, then joins the channel",
  async (t) => {
    const channel = unjoinedChannel();
    let calls: [string, unknown][] = [];
    prepare = (replica) => (calls = recordWrites(replica));
    const inviter = { name: "Ines Vidal", handle: "ines.v" };
    let me: object = waitingTestUser({ login: "rheaok" });
    // the page load back from the provider restored the channel's code
    savePendingInvite({ kind: "channel", channel: channel.name, code: "k3v8q2m9" });
    const app = await renderApp("/welcome?new=1", {
      user: me as never,
      responses: {
        "auth.me": () => me,
        "accountInvites.redeem": { status: "open", inviter },
        "account.checkHandle": { valid: true, available: true },
        "account.create": (input: unknown) => {
          const { handle } = input as { handle: string };
          me = { ...waitingTestUser({ login: "rheaok" }), status: "active", handle };
          return { me, inviter };
        },
      },
    });
    const dialog = await screen.findByRole("dialog", { name: "Sign in to Session" });
    fireEvent.click(await within(dialog).findByRole("button", { name: "Enter an invite code" }));
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Invite code" }), {
      target: { value: "SESS-9TQ2-X8" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Continue" }));
    fireEvent.change(await within(dialog).findByRole("textbox", { name: /Handle on Session/ }), {
      target: { value: "rhea" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create account" }));
    await waitUntil(
      t,
      () => app.router.state.location.pathname === `/c/${channel.name}`,
      "to the channel",
    );
    await waitUntil(t, () => calls.some(([n]) => n === "spaces.join"), "the join is sent");
    t.deepEqual(
      calls.filter(([n]) => n === "spaces.join"),
      [["spaces.join", { space: channel.id, invite: "k3v8q2m9" }]],
    );
    await waitUntil(t, () => currentToast() === `Joined #${channel.name}.`, "the Joined toast");
    t.is(readPendingInvite(), null);
  },
);

test("a channel invite kept across a sign-in expires after 30 minutes", (t) => {
  const store = new Map<string, string>();
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  const at = 1_700_000_000_000;
  const keep = () =>
    storage.setItem(CHANNEL_INVITE_KEY, JSON.stringify({ channel: "lab", code: "abc", at }));
  keep();
  t.is(restoreChannelInvite(storage, at + CHANNEL_INVITE_TTL_MS), null);
  t.is(store.size, 0, "removed all the same");
  t.is(readPendingInvite(), null);
  keep();
  t.deepEqual(restoreChannelInvite(storage, at + CHANNEL_INVITE_TTL_MS - 1), {
    kind: "channel",
    channel: "lab",
    code: "abc",
  });
  clearPendingInvite();
});

test("the sign-in's return address leaves out the fragment", (t) => {
  t.is(safeReturn("/c/lab#k3v8q2m9"), "/c/lab");
  t.is(
    safeReturn("/c/lab?t=01M7HWGZJGT7JTFFVSYPX0L001#k3v8q2m9"),
    "/c/lab?t=01M7HWGZJGT7JTFFVSYPX0L001",
  );
  t.is(safeReturn("/i#SESS-9TQ2-X8"), null);
});

test.serial("an open channel's owner has no Invite to #name", async (t) => {
  await renderApp("/c/sci-fi");
  fireEvent.click(await screen.findByRole("button", { name: "About this channel" }));
  const info = await screen.findByRole("dialog", { name: "#sci-fi" });
  t.is(within(info).queryByRole("button", { name: /^Invite to/ }), null);
  t.truthy(within(info).getByRole("button", { name: "Moderation log" }));
});

// --------------------------------------------------------- frozen channels

test.serial("a frozen channel: the banner, no composer, no new replies", async (t) => {
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

/** @ines.v's post in #ml (owned by @jun.park), with others' replies. */
const SEED_POST = "01M7GNRKE0SEEDP0ST00000000";
/** A thread on Home with branches (`feed.states.test.tsx` FIRST). */
const BRANCHED = "01M7HWGZJGT7JTFFVSYPX055KV";
const OWN_REPLY = "01M7HWGZJGT7JTFFVSYPX0RP01";
const OWN_COMMENT = "01M7HWGZJGT7JTFFVSYPX0CM03";

const side = (thread: string) =>
  document.querySelector<HTMLElement>(`[data-side="${thread}"]`) as HTMLElement;

test.serial(
  "a frozen channel keeps Delete on the viewer's own thread and reply, and Save",
  async (t) => {
    prepare = (replica) => {
      const ml = space(replica, "ml-papers");
      rewrite(replica, ml, { frozen: true });
      replica.write([
        {
          kind: "reply",
          id: OWN_REPLY,
          th: SEED_POST,
          s: ml.kind === "space" ? ml.id : "",
          u: "ines.v",
          t: "My own reply to the thread",
          parent: null,
          edited: false,
          del: false,
          mod: null,
          createdAt: "2026-11-16T09:30:00Z",
        },
      ]);
    };
    await renderApp("/c/ml-papers");
    await waitUntil(t, () => document.getElementById(`card-${SEED_POST}`) !== null, "the post");
    const card = document.getElementById(`card-${SEED_POST}`) as HTMLElement;
    fireEvent.click(within(card).getByRole("button", { name: "More" }));
    t.truthy(await screen.findByRole("menuitem", { name: /^Delete post/ }));
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    // Save is the viewer's own record: it stays
    const calls = recordWrites(replicaOf());
    const save = within(card).getByRole("button", { name: /^Save/ });
    t.false((save as HTMLButtonElement).disabled);
    fireEvent.click(save);
    await waitUntil(t, () => calls.length > 0, "the save is sent");
    t.like(calls[0], ["saved.set", { kind: "thread", id: SEED_POST }]);
    // the viewer's own reply keeps its Delete
    fireEvent.click(within(side(SEED_POST)).getByRole("treeitem", { name: /My own reply/ }));
    await waitUntil(
      t,
      () => side(SEED_POST).querySelector(".preview .rtext") !== null,
      "the reply's card renders",
    );
    const reply = side(SEED_POST).querySelector(".preview .rtext")?.closest(".preview");
    fireEvent.click(within(reply as HTMLElement).getByRole("button", { name: "More" }));
    t.truthy(await screen.findByRole("menuitem", { name: "Delete reply" }));
  },
);

test.serial(
  "the viewer's own branch and comment keep Delete in a frozen channel; a comment's Delete sends comments.delete",
  async (t) => {
    let node = "";
    let label = "";
    prepare = (replica) => {
      const n = replica.rawAll("node").find((x) => x.th === BRANCHED && /darknet/.test(x.q));
      if (!n) throw new Error("no branch");
      node = n.id;
      label = "how does the darknet";
      rewrite(replica, n, { u: "ines.v" });
      const s = replica.raw(`space:${n.s}`);
      if (s) rewrite(replica, s, { frozen: true });
      replica.write([
        {
          kind: "comment",
          id: OWN_COMMENT,
          th: BRANCHED,
          s: n.s,
          node: n.id,
          parent: null,
          u: "ines.v",
          t: "My own comment on the branch",
          edited: false,
          del: false,
          mod: null,
          createdAt: "2026-11-16T09:40:00Z",
        },
      ]);
    };
    await renderApp("/");
    await waitUntil(t, () => side(BRANCHED) !== null, "the side column renders");
    fireEvent.click(within(side(BRANCHED)).getByRole("treeitem", { name: new RegExp(label) }));
    const comment = (
      await within(side(BRANCHED)).findByText("My own comment on the branch")
    ).closest(".brr") as HTMLElement;
    const branch = comment.closest(".preview") as HTMLElement;
    t.truthy(node);
    fireEvent.click(
      within(branch.querySelector(".who") as HTMLElement).getByRole("button", { name: "More" }),
    );
    t.truthy(await screen.findByRole("menuitem", { name: /^Delete branch/ }));
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    const calls = recordWrites(replicaOf());
    fireEvent.click(within(comment).getByRole("button", { name: "More" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete comment" }));
    const confirm = await screen.findByRole("alertdialog", {
      name: "Delete this comment and your replies under it?",
    });
    t.deepEqual(calls, []);
    fireEvent.click(within(confirm).getByRole("button", { name: "Delete" }));
    await waitUntil(t, () => calls.length > 0, "the delete is sent");
    t.deepEqual(calls[0], ["comments.delete", { id: OWN_COMMENT }]);
  },
);

/** Selects the branch row `label` in a thread's side column and answers its
 * card's "…" menu items, then closes the menu. */
async function branchMenu(t: ExecutionContext, thread: string, label: RegExp): Promise<string[]> {
  fireEvent.click(within(side(thread)).getByRole("treeitem", { name: label }));
  const card = side(thread).querySelector<HTMLElement>(".preview .who");
  if (!card) throw new Error("no branch card");
  fireEvent.click(within(card).getByRole("button", { name: "More" }));
  const menu = await screen.findByRole("menu");
  const items = within(menu)
    .getAllByRole("menuitem")
    .map((item) => item.textContent ?? "");
  fireEvent.keyDown(menu, { key: "Escape" });
  await waitUntil(t, () => screen.queryByRole("menu") === null, "the menu closes");
  return items;
}

test.serial(
  "Open as its own thread is offered only where the server accepts it: answered, not hidden (03 G5)",
  async (t) => {
    const UNANSWERED = "01M7HWGZJGT7JTFFVSYPX0NA01";
    prepare = (replica) => {
      const nodes = replica.rawAll("node").filter((x) => x.th === BRANCHED);
      const hidden = nodes.find((x) => /^which lem stories/.test(x.q));
      const answered = nodes.find((x) => /darknet/.test(x.q));
      if (!hidden || !answered) throw new Error("no branches");
      rewrite(replica, hidden, { mod: "hidden", modBy: "jun.park", u: "ines.v" });
      replica.write([
        { ...answered, id: UNANSWERED, q: "a branch with no answer yet", promoted: null },
      ]);
    };
    await renderApp("/");
    await waitUntil(t, () => side(BRANCHED) !== null, "the side column renders");
    const OPEN = "Open as its own thread";
    t.true((await branchMenu(t, BRANCHED, /how does the darknet/)).includes(OPEN), "answered");
    t.false((await branchMenu(t, BRANCHED, /which lem stories/)).includes(OPEN), "hidden");
    t.false(
      (await branchMenu(t, BRANCHED, /a branch with no answer yet/)).includes(OPEN),
      "no answer",
    );
  },
);

test.serial("after deleting one's comment, focus is on the selected branch row", async (t) => {
  let node = "";
  prepare = (replica) => {
    const n = replica.rawAll("node").find((x) => x.th === BRANCHED && /darknet/.test(x.q));
    if (!n) throw new Error("no branch");
    node = n.id;
    replica.write([
      {
        kind: "comment",
        id: OWN_COMMENT,
        th: BRANCHED,
        s: n.s,
        node: n.id,
        parent: null,
        u: "ines.v",
        t: "My own comment on the branch",
        edited: false,
        del: false,
        mod: null,
        createdAt: "2026-11-16T09:40:00Z",
      },
    ]);
  };
  await renderApp("/");
  await waitUntil(t, () => side(BRANCHED) !== null, "the side column renders");
  fireEvent.click(within(side(BRANCHED)).getByRole("treeitem", { name: /how does the darknet/ }));
  const comment = (await within(side(BRANCHED)).findByText("My own comment on the branch")).closest(
    ".brr",
  ) as HTMLElement;
  fireEvent.click(within(comment).getByRole("button", { name: "More" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Delete comment" }));
  const confirm = await screen.findByRole("alertdialog", {
    name: "Delete this comment and your replies under it?",
  });
  fireEvent.click(within(confirm).getByRole("button", { name: "Delete" }));
  await waitUntil(
    t,
    () => within(side(BRANCHED)).queryByText("My own comment on the branch") === null,
    "the comment is gone",
  );
  const row = side(BRANCHED).querySelector<HTMLElement>(`[data-row="${node}"]`);
  t.is(row?.getAttribute("aria-selected"), "true");
  await waitUntil(t, () => document.activeElement === row, "focus on the selected row");
  // and it stays there once the dialog has finished closing
  await new Promise((resolve) => setTimeout(resolve, 100));
  t.is(document.activeElement, row);
});

test.serial("clicking a collapsed reply's +N expands it and keeps focus on its row", async (t) => {
  const TOP = "01M7GGE530GDFVANPJE04YBAQN";
  prepare = (replica) => {
    const top = replica.raw(`reply:${TOP}`);
    if (top?.kind !== "reply") throw new Error("no reply");
    replica.write([
      {
        ...top,
        id: "01M7HWGZJGT7JTFFVSYPX0RP09",
        parent: TOP,
        u: "jun.park",
        t: "A reply under the first one",
        createdAt: "2026-11-16T09:50:00Z",
      },
    ]);
  };
  useThreadUiStore.getState().toggleCollapsed(SEED_POST, TOP);
  await renderApp("/c/ml-papers");
  await waitUntil(t, () => side(SEED_POST) !== null, "the side column renders");
  const more = await within(side(SEED_POST)).findByRole("button", { name: "Show 1 more reply" });
  more.focus();
  fireEvent.click(more);
  await waitUntil(
    t,
    () => within(side(SEED_POST)).queryByText("A reply under the first one") !== null,
    "the reply under it shows",
  );
  const row = side(SEED_POST).querySelector<HTMLElement>(`[data-row="${TOP}"]`);
  await waitUntil(t, () => document.activeElement === row, "focus on the reply's row");
});

test.serial(
  "a branch and a comment that were not sent show Not sent under them while shown, else in the outbox toast",
  async (t) => {
    let node = "";
    const discarded: string[] = [];
    prepare = (replica) => {
      const n = replica.rawAll("node").find((x) => x.th === BRANCHED && /darknet/.test(x.q));
      if (!n) throw new Error("no branch");
      node = n.id;
      replica.write([
        {
          kind: "comment",
          id: OWN_COMMENT,
          th: BRANCHED,
          s: n.s,
          node: n.id,
          parent: null,
          u: "ines.v",
          t: "My own comment on the branch",
          edited: false,
          del: false,
          mod: null,
          createdAt: "2026-11-16T09:40:00Z",
        },
      ]);
      // the fixture replica sends every write at once: these two read as
      // the sync replica's "Not sent" writes
      const unsent: UnsentWrite[] = [
        { local: "L1", name: "research.forkNode", input: {}, item: n.id, error: null },
        { local: "L2", name: "comments.create", input: {}, item: OWN_COMMENT, error: null },
      ];
      Object.assign(replica, {
        unsent: () => unsent,
        discard: (local: string) => discarded.push(local),
      });
    };
    const outbox = () => document.querySelector<HTMLElement>("[data-outbox-toast]");
    await renderApp("/");
    await waitUntil(t, () => side(BRANCHED) !== null, "the side column renders");
    await waitUntil(t, () => outbox() !== null, "neither is on screen: the toast lists both");
    t.is(outbox()?.textContent?.startsWith("2 changes not sent."), true);

    fireEvent.click(within(side(BRANCHED)).getByRole("treeitem", { name: /how does the darknet/ }));
    const card = side(BRANCHED).querySelector<HTMLElement>(".preview") as HTMLElement;
    await waitUntil(t, () => card.querySelectorAll("[data-not-sent]").length === 2, "two lines");
    const [branchLine, commentLine] = [...card.querySelectorAll<HTMLElement>("[data-not-sent]")];
    t.is(branchLine?.previousElementSibling?.classList.contains("who"), true, "under the author");
    t.truthy(branchLine?.closest(".preview") === card && !branchLine.closest(".brr"));
    t.truthy(commentLine?.closest(".brr")?.textContent?.includes("My own comment on the branch"));
    t.is(outbox(), null, "the lines show both, so the toast is gone");

    fireEvent.click(within(commentLine as HTMLElement).getByRole("button", { name: "Discard" }));
    t.deepEqual(discarded, ["L2"]);
    t.truthy(node);
  },
);

test.serial("another person's comment has no Delete", async (t) => {
  prepare = (replica) => {
    const n = replica.rawAll("node").find((x) => x.th === BRANCHED && /darknet/.test(x.q));
    if (!n) throw new Error("no branch");
    replica.write([
      {
        kind: "comment",
        id: OWN_COMMENT,
        th: BRANCHED,
        s: n.s,
        node: n.id,
        parent: null,
        u: "mira_k",
        t: "A comment by someone else",
        edited: false,
        del: false,
        mod: null,
        createdAt: "2026-11-16T09:40:00Z",
      },
    ]);
  };
  await renderApp("/");
  await waitUntil(t, () => side(BRANCHED) !== null, "the side column renders");
  fireEvent.click(within(side(BRANCHED)).getByRole("treeitem", { name: /how does the darknet/ }));
  const comment = (await within(side(BRANCHED)).findByText("A comment by someone else")).closest(
    ".brr",
  ) as HTMLElement;
  t.is(within(comment).queryByRole("button", { name: "More" }), null);
});

test.serial("a non-member sees Join on an open channel, and none once it is frozen", async (t) => {
  const channel = unjoinedChannel();
  const app = await renderApp(`/c/${channel.name}`);
  t.truthy(await screen.findByRole("button", { name: "Join" }));
  app.unmount();
  prepare = (replica) => rewrite(replica, space(replica, channel.name), { frozen: true });
  await renderApp(`/c/${channel.name}`);
  await screen.findByText(new RegExp(`^#${channel.name} is frozen:`));
  t.is(screen.queryByRole("button", { name: "Join" }), null);
});

test.serial("the strip under All offers no Join on a frozen channel", async (t) => {
  const channel = unjoinedChannel();
  useNavigationStore.getState().setScope("all");
  t.teardown(() => useNavigationStore.getState().setScope("joined"));
  const strip = () => screen.getByRole("navigation", { name: "Channels" });
  const app = await renderApp("/");
  await waitUntil(
    t,
    () => within(strip()).queryByRole("link", { name: `#${channel.name}` }) !== null,
    "the chip",
  );
  t.truthy(within(strip()).getByRole("button", { name: `Join #${channel.name}` }));
  app.unmount();
  prepare = (replica) => rewrite(replica, space(replica, channel.name), { frozen: true });
  await renderApp("/");
  await waitUntil(
    t,
    () => within(strip()).queryByRole("link", { name: `#${channel.name}` }) !== null,
    "the chip",
  );
  t.is(within(strip()).queryByRole("button", { name: `Join #${channel.name}` }), null);
});

test.serial("Browse: a frozen channel is by Deleted account and has no Join (04 B6)", async (t) => {
  const channel = unjoinedChannel();
  const card = async () =>
    (await screen.findByText(`#${channel.name}`, { selector: "b" })).closest(
      ".bcard",
    ) as HTMLElement;
  const app = await renderApp("/browse");
  const open = await card();
  t.regex(open.textContent ?? "", /by @\S+ · \d+ members?/);
  t.truthy(within(open).getByRole("button", { name: "Join" }));
  app.unmount();
  prepare = (replica) => rewrite(replica, space(replica, channel.name), { frozen: true });
  await renderApp("/browse");
  const frozen = await card();
  t.regex(frozen.textContent ?? "", /by Deleted account · \d+ members?/);
  t.notRegex(frozen.textContent ?? "", /by @/);
  t.is(within(frozen).queryByRole("button", { name: "Join" }), null);
});

test.serial("a frozen channel is left out of the composer's channel picker", async (t) => {
  prepare = (replica) => rewrite(replica, space(replica, "public"), { frozen: true });
  await renderApp("/");
  fireEvent.click(await screen.findByTitle("Channel"));
  t.truthy(await screen.findByRole("menuitemradio", { name: /#sci-fi/ }));
  t.is(screen.queryByRole("menuitemradio", { name: /#public/ }), null);
});

// ------------------------------------------------------------- moderation

test.serial(
  "a removed thread's placeholder names no author to its author, to the owner or to another reader",
  async (t) => {
    const removed = (r: StoredRecord, modBy: string, u: string | null) => ({
      ...r,
      u,
      mod: "removed",
      modBy,
      modNote: null,
      q: "",
      t: null,
      sum: null,
    });
    const ids = { author: "", owner: "", reader: "" };
    prepare = (replica) => {
      const find = (name: string, by: (u: string | null) => boolean) => {
        const sp = channelByName(replica, name);
        const r = replica
          .rawAll("thread")
          .find((x) => x.s === sp?.id && x.k === "post" && x.mod === null && !x.del && by(x.u));
        if (!r) throw new Error(`no post in #${name}`);
        return r;
      };
      // the author's own post (the author's replica keeps `u`)
      const own = find("ml-papers", (u) => u === "ines.v");
      // a post in the viewer's channel, and one in a channel of another owner
      const inOwned = find("sci-fi", (u) => u !== "ines.v");
      const inOther = find("public", (u) => u !== "ines.v");
      ids.author = own.id;
      ids.owner = inOwned.id;
      ids.reader = inOther.id;
      replica.write([
        removed(own, "jun.park", "ines.v"),
        removed(inOwned, "ines.v", null),
        removed(inOther, "sol", null),
      ] as StoredRecord[]);
    };
    await renderApp("/");
    const cards = Object.entries(ids).map(([who, id]) => [who, id] as const);
    for (const [who, id] of cards)
      await waitUntil(t, () => document.getElementById(`card-${id}`) !== null, `${who}'s card`);
    const text = (id: string) => document.getElementById(`card-${id}`)?.textContent ?? "";
    t.regex(text(ids.author), /Post by \[deleted\] in #ml-papers/);
    t.false(text(ids.author).includes("@ines.v"), "the author's own handle is not shown");
    t.regex(text(ids.owner), /Post by \[deleted\] in #sci-fi/);
    t.regex(text(ids.reader), /Post by \[deleted\] in #public/);
    // the author keeps Delete on the placeholder
    const own = document.getElementById(`card-${ids.author}`) as HTMLElement;
    t.truthy(within(own).getByRole("button", { name: "More" }));
  },
);

test.serial(
  "the content of a deleted account reads “Deleted account”: a thread, a reply, a branch and a comment",
  async (t) => {
    let reply = "";
    let thread = "";
    prepare = (replica) => {
      const r = replica.rawAll("reply").find((x) => x.th === SEED_POST && !x.del);
      const n = replica.rawAll("node").find((x) => x.th === BRANCHED && /darknet/.test(x.q));
      const th = replica.rawAll("thread").find((x) => x.id === BRANCHED);
      if (!r || !n || !th) throw new Error("fixtures missing");
      reply = r.id;
      thread = th.id;
      replica.write([
        { ...r, u: null },
        { ...n, u: null },
        { ...th, u: null },
        {
          kind: "comment",
          id: OWN_COMMENT,
          th: BRANCHED,
          s: n.s,
          node: n.id,
          parent: null,
          u: null,
          t: "A comment left by a deleted account",
          edited: false,
          del: false,
          mod: null,
          createdAt: "2026-11-16T09:40:00Z",
        },
      ] as StoredRecord[]);
    };
    await renderApp("/");
    await waitUntil(t, () => side(BRANCHED) !== null && side(SEED_POST) !== null, "the rows");
    // the thread's avatar names the deleted account and shows no initials
    const card = document.getElementById(`card-${thread}`) as HTMLElement;
    const av = card.querySelector<HTMLElement>(".ttav");
    t.regex(av?.getAttribute("title") ?? "", /^Deleted account · /);
    t.is(av?.querySelector("[data-deleted-account]")?.textContent, "");
    // the reply's row and card
    const row = side(SEED_POST).querySelector<HTMLElement>(`[data-row="${reply}"]`);
    t.regex(row?.textContent ?? "", /^Deleted account: /);
    fireEvent.click(row as HTMLElement);
    await waitUntil(
      t,
      () => side(SEED_POST).querySelector(".preview .who b") !== null,
      "the reply's card",
    );
    t.is(side(SEED_POST).querySelector(".preview .who b")?.textContent, "Deleted account");
    // the branch's card and the comment under it
    fireEvent.click(within(side(BRANCHED)).getByRole("treeitem", { name: /how does the darknet/ }));
    const comment = (
      await within(side(BRANCHED)).findByText("A comment left by a deleted account")
    ).closest(".brr") as HTMLElement;
    t.is(comment.querySelector(".who b")?.textContent, "Deleted account");
    const branch = comment.closest(".preview") as HTMLElement;
    t.is(branch.querySelector(":scope > .who b")?.textContent, "Deleted account");
    t.false((document.body.textContent ?? "").includes("@null"));
  },
);

test.serial("a moderation log entry of a removal shows no title of the item", async (t) => {
  let title = "";
  prepare = (replica) => {
    const s = space(replica, "sci-fi");
    const sp = s.kind === "space" ? s.id : "";
    const thread = replica
      .rawAll("thread")
      .find((x) => x.s === sp && x.k === "post" && x.q !== "" && x.u !== "ines.v");
    if (!thread?.u) throw new Error("no post");
    title = thread.q;
    replica.write([
      {
        kind: "modlog",
        id: "01M7HWGZJGT7JTFFVSYPX0ML01",
        sp,
        act: "remove",
        item: `p:${thread.id}`,
        by: "ines.v",
        author: thread.u,
        note: "Off topic",
        createdAt: "2026-11-16T09:50:00Z",
      },
    ]);
  };
  await renderApp("/c/sci-fi");
  fireEvent.click(await screen.findByRole("button", { name: "About this channel" }));
  const info = await screen.findByRole("dialog", { name: /^#sci-fi/ });
  fireEvent.click(within(info).getByRole("button", { name: "Moderation log" }));
  const log = await screen.findByRole("dialog", { name: "Moderation log" });
  const entry = within(log).getByText("Reason: “Off topic”").closest("li") as HTMLElement;
  t.regex(entry.textContent ?? "", /^Removed@ines\.v removed @.+'s post/);
  t.false((log.textContent ?? "").includes(title.slice(0, 20)), "no title of the item");
});

// ------------------------------------------------- refusals at apply time

/** The server's refusals of 04 §9, rendered by the client: a post refused
 * for a ban, or because the channel froze while it was on its way, shows the
 * server's message and leaves the text in the composer. */
for (const [why, message] of [
  ["a ban", "You are banned from #public."],
  ["a frozen channel", "#public is frozen because its owner’s account is not active."],
] as const)
  test.serial(`a post refused for ${why} shows the message and keeps the text`, async (t) => {
    await renderApp("/c/public");
    const field = await screen.findByRole("textbox", { name: "Ask or post" });
    recordWrites(replicaOf(), (name) =>
      name === "threads.create" ? { ok: false, error: { code: "FORBIDDEN", message } } : null,
    );
    fireEvent.click(screen.getByRole("button", { name: "Ask or post" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /^Post/ }));
    fireEvent.change(field, { target: { value: "Still posting here" } });
    fireEvent.click(screen.getByRole("button", { name: "Post" }));
    await waitUntil(t, () => currentToast() === message, "the refusal's toast");
    t.is((field as HTMLTextAreaElement).value, "Still posting here");
  });
