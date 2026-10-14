// Collaboration on the client (web only): the Share dialog, what each role
// is offered on the thread page, author chips and the Edited mark, presence
// and its renewal, the stale-edit prompt, the Shared with me place and the
// invitation route.

import type {
  ResearchNode,
  ResearchNodeContent,
  ResearchParticipant,
  ResearchTree,
  ResearchTreeDetail,
  ResearchTreeSummary,
  SessionEvent,
  ThreadInvite,
  ThreadMember,
  Turn,
} from "@session/shared";
import { QueryClient } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import test from "ava";

import { mergeTreeEvent } from "../src/api/cache.js";
import {
  addTreeInterest,
  applyEventBatch,
  connectEventBridge,
  resetNodeInterest,
} from "../src/api/events.js";
import { queryClientDefaults, queryKeys } from "../src/api/queries.js";
import { TreeLifecycleItems } from "../src/features/home/TreeMenu.js";
import { stalledChainNote } from "../src/features/sharing/context.js";
import {
  mayCancel,
  mayChangeHighlights,
  mayChangeNode,
  mayEditText,
  mayRelaunch,
  mayRemoveHighlight,
  OWNER_ARCHIVED_MESSAGE,
  archivedByOwner,
  threadPermissions,
} from "../src/features/sharing/permissions.js";
import { SelectionToolbar } from "../src/features/thread/SelectionToolbar.js";
import { DeleteDialog as ThreadDeleteDialog } from "../src/features/thread/ThreadDialogs.js";
import { resetThreadNavigationForTests } from "../src/features/thread/persistence.js";
import type { SelectionAction } from "../src/features/thread/selectionCapture.js";
import { useDraftsStore } from "../src/stores/drafts.js";
import { useLiveTurnsStore } from "../src/stores/liveTurns.js";
import { useOverlaysStore } from "../src/stores/overlays.js";
import { Menu } from "../src/ui/Menu.js";

import { node, summary, tree } from "./fixtures.js";
import { renderApp, resetDocumentRoot, waitUntil } from "./helpers.js";
import { createTrpcStub } from "./trpcStub.js";

/** Card lifecycle items inside an open menu. */
function TreeLifecycleItemsHarness({ tree: summaryRow }: { tree: ResearchTreeSummary }) {
  return (
    <Menu open label="Card" trigger={<button type="button">Open</button>}>
      <TreeLifecycleItems tree={summaryRow} archived onRestore={() => {}} onDelete={() => {}} />
    </Menu>
  );
}

const REVISION = "c".repeat(64);
const OWNER = "u0";
const ME = "u1";

const PEOPLE: ResearchParticipant[] = [
  { id: OWNER, login: "ada", name: "Ada", avatarUrl: null },
  { id: ME, login: "raymond", name: "Raymond", avatarUrl: null },
  { id: "u2", login: "grace", name: "Grace", avatarUrl: null },
];

function answer(id: string, text: string): Turn {
  return { id, agentId: "n1", role: "assistant", blocks: [{ type: "text", text }], sourceIndex: 0 };
}

function contentFor(target: ResearchNode, text: string): ResearchNodeContent {
  return { node: target, turns: [answer(`${target.id}-t`, text)], responseRevision: REVISION };
}

function post(overrides: Partial<ResearchNode> & { text?: string } = {}): ResearchNode {
  const { text = "A note about memory", ...rest } = overrides;
  return {
    id: "n1",
    treeId: "t1",
    groupId: "w1",
    parentNodeId: null,
    title: null,
    createdAt: 1_700_000_000_000,
    highlights: [],
    type: "post",
    format: "text",
    message: { text },
    followUpAgent: { adapter: "gemini", model: "gemini-flash", effort: null },
    ...rest,
  } as ResearchNode;
}

function testQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { ...queryClientDefaults.queries, gcTime: Number.POSITIVE_INFINITY },
      mutations: { gcTime: Number.POSITIVE_INFINITY },
    },
  });
}

const MODELS = [
  {
    id: "gemini-flash",
    label: "Gemini 3.8 Flash",
    provider: "vertex",
    adminOnly: false,
    available: true,
    supportsFiles: true,
    supportsImages: true,
  },
];

function conflict(message: string): Error {
  return Object.assign(new Error(message), { data: { code: "CONFLICT" } });
}

interface Scenario {
  tree?: Partial<ResearchTree>;
  nodes: ResearchNode[];
  participants?: ResearchParticipant[];
  contentByNode?: Record<string, ResearchNodeContent>;
  responses?: Record<string, unknown>;
  path?: string;
}

async function mount(scenario: Scenario) {
  const detail: ResearchTreeDetail = {
    tree: tree({ ownerId: OWNER, ...scenario.tree }),
    nodes: scenario.nodes,
    ...(scenario.participants ? { participants: scenario.participants } : {}),
  };
  return renderApp(scenario.path ?? "/r/t1", {
    queryClient: testQueryClient(),
    responses: {
      "research.getTree": () => detail,
      "research.getNodeContent": (input: unknown) =>
        scenario.contentByNode?.[(input as { nodeId: string }).nodeId],
      "research.markTreeViewed": detail.tree,
      "system.runtimeConfig": { version: "0.0.0", models: MODELS, limits: {}, features: {} },
      ...scenario.responses,
    },
  });
}

/** A complete root by the owner and an inline follow-up by the reader. */
function ownerAndMine(): {
  root: ResearchNode;
  mine: ResearchNode;
  content: Scenario["contentByNode"];
} {
  const root = node({ id: "n1", status: "complete", authorId: OWNER });
  const mine = node({
    id: "n2",
    parentNodeId: "n1",
    inline: true,
    status: "complete",
    prompt: "And my follow-up?",
    authorId: ME,
    createdAt: 1_700_000_001_000,
  });
  return {
    root,
    mine,
    content: { n1: contentFor(root, "Root answer."), n2: contentFor(mine, "Second answer.") },
  };
}

async function openMenuOf(rowText: string): Promise<HTMLElement> {
  const row = (await waitFor(() => screen.getByText(rowText))).closest("li") as HTMLElement;
  fireEvent.click(within(row).getByRole("button", { name: "Answer actions" }));
  return waitFor(() => screen.getByRole("menu", { name: "Answer actions" }));
}

function menuItems(menu: HTMLElement): string[] {
  return within(menu)
    .queryAllByRole("menuitem")
    .map((item) => item.textContent?.trim() ?? "");
}

test.afterEach.always(() => {
  try {
    cleanup();
  } finally {
    document.body.innerHTML = "";
  }
  resetDocumentRoot();
  resetNodeInterest();
  useOverlaysStore.getState().clear();
  useLiveTurnsStore.getState().clearAll();
  useDraftsStore.setState({ byKey: {} });
  localStorage.clear();
  sessionStorage.clear();
  resetThreadNavigationForTests();
});

/* --------------------------------------------------------- permissions */

test("a stalled chain's note says who can retry it", (t) => {
  const people = {
    byId: new Map([[OWNER, { id: OWNER, login: "ada", name: "Ada", avatarUrl: null }]]),
  };
  const commenter = threadPermissions({ role: "commenter", ownerId: OWNER }, ME);
  const owner = threadPermissions({ role: "owner", ownerId: OWNER }, OWNER);
  // The payer gets the desktop's sentences.
  t.is(
    stalledChainNote({ authorId: ME, status: "failed" }, commenter, people),
    "The last answer stopped with an error. Retry it or edit its question to continue.",
  );
  t.is(
    stalledChainNote({ authorId: OWNER, status: "stopped" }, owner, people),
    "The last answer was stopped. Run it again to continue.",
  );
  // Someone else's answer: who can retry it, and that the owner can delete it.
  t.is(
    stalledChainNote({ authorId: OWNER, status: "failed" }, commenter, people),
    "The last answer stopped. Only Ada can retry or delete it. Branch from the answer before it to continue.",
    "the payer is the owner",
  );
  t.is(
    stalledChainNote({ authorId: "u3", status: "failed" }, commenter, people),
    "The last answer stopped. Only the person who asked it can retry it; the owner can delete it. Branch from the answer before it to continue.",
  );
  t.is(
    stalledChainNote({ authorId: "u-gone", status: "failed" }, owner, people),
    "The last answer stopped. Only the person who asked it can retry it. Delete it, or branch from the answer before it to continue.",
  );
});

test("an owner-archived shared thread can't be unarchived by a member", (t) => {
  const archived = summary({ archivedAt: 5, role: "commenter", ownerId: OWNER });
  t.true(archivedByOwner({ ...archived, archivedBy: "owner" }));
  t.false(archivedByOwner({ ...archived, archivedBy: "me" }));
  t.false(archivedByOwner(archived), "without the marker the server decides");
  t.false(archivedByOwner({ ...archived, role: "owner", archivedBy: "owner" }));
  render(<TreeLifecycleItemsHarness tree={{ ...archived, archivedBy: "owner" }} />);
  const item = screen.getByRole("menuitem", { name: "Unarchive research" });
  t.is(item.getAttribute("aria-disabled") ?? String(item.hasAttribute("data-disabled")), "true");
  t.is(item.getAttribute("title"), OWNER_ARCHIVED_MESSAGE);
  cleanup();
});

test("the thread page's Delete for a member moves it to their Trash or leaves", (t) => {
  const root = node({ id: "n1", status: "complete" });
  render(
    <ThreadDeleteDialog
      nodes={[root]}
      nodeId="n1"
      rootNodeId="n1"
      treeTitle="Collective memory"
      shared
      onTrashRoot={() => Promise.resolve()}
      onRemove={() => Promise.resolve()}
      onClose={() => {}}
    />,
  );
  const dialog = screen.getByRole("dialog", { name: /^Delete “.+”\?$/ });
  t.truthy(
    within(dialog).getByText(
      "It moves to your Trash. Its owner and the other people in it still have it.",
    ),
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete now" }));
  const leave = screen.getByRole("dialog", { name: /^Leave “.+”\?$/ });
  t.truthy(within(leave).getByRole("button", { name: "Leave" }));
  t.is(screen.queryByText("Delete permanently?"), null);
  cleanup();
});

test("the permission rules follow the server's", (t) => {
  const nodes = [
    node({ id: "a", authorId: ME, status: "complete" }),
    node({ id: "b", parentNodeId: "a", authorId: OWNER, status: "complete" }),
    node({ id: "c", authorId: ME, status: "complete" }),
  ];
  const [a, b, c] = nodes as [ResearchNode, ResearchNode, ResearchNode];
  const commenter = threadPermissions({ role: "commenter", ownerId: OWNER }, ME);
  t.true(commenter.canContribute);
  t.false(commenter.canReorder);
  t.false(commenter.canShare);
  // Their own node, until someone else replies under it.
  t.false(mayChangeNode(commenter, nodes, a));
  t.true(mayChangeNode(commenter, nodes, c));
  t.false(mayChangeNode(commenter, nodes, b));
  t.true(mayEditText(commenter, nodes, c));
  t.false(mayEditText(commenter, nodes, b));
  // Relaunch is the payer's; Stop is the asker's or the owner's.
  t.true(mayRelaunch(commenter, c));
  t.false(mayRelaunch(commenter, b));
  t.true(mayCancel(commenter, c));
  t.false(mayCancel(commenter, b));
  t.true(
    mayRemoveHighlight(commenter, { id: "h", anchor: {} as never, createdAt: 0, authorId: ME }),
  );
  t.false(
    mayRemoveHighlight(commenter, { id: "h", anchor: {} as never, createdAt: 0, authorId: OWNER }),
  );

  // A selection over saved highlights removes or merges them: a commenter's
  // own only; the owner any.
  const mineHighlight = { id: "h1", anchor: {} as never, createdAt: 0, authorId: ME };
  const theirs = { id: "h2", anchor: {} as never, createdAt: 0, authorId: OWNER };
  t.true(mayChangeHighlights(commenter, [mineHighlight, theirs], []));
  t.true(mayChangeHighlights(commenter, [mineHighlight, theirs], ["h1"]));
  t.false(mayChangeHighlights(commenter, [mineHighlight, theirs], ["h1", "h2"]));
  t.false(mayChangeHighlights(commenter, [mineHighlight], ["gone"]));

  const viewer = threadPermissions({ role: "viewer", ownerId: OWNER }, ME);
  t.false(viewer.canContribute);
  t.false(mayChangeNode(viewer, nodes, c));
  t.false(mayRelaunch(viewer, c));

  const owner = threadPermissions({ role: "owner", ownerId: OWNER }, OWNER);
  t.true(owner.canReorder && owner.canShare && owner.canRenameThread);
  t.true(mayChangeNode(owner, nodes, a));
  // The author edits the text, the owner too only when the author is gone.
  t.false(mayEditText(owner, nodes, c));
  t.true(mayEditText(owner, nodes, node({ id: "d", authorId: null })));
  t.false(mayRelaunch(owner, c));
  t.true(mayCancel(owner, c));
  t.true(mayChangeHighlights(owner, [mineHighlight, theirs], ["h1", "h2"]));

  const guest = threadPermissions({ role: "viewer", ownerId: OWNER }, null);
  t.is(guest.role, "guest");
  t.false(guest.canFollow);

  const archived = threadPermissions({ role: "owner", ownerId: OWNER, archivedAt: 1 }, OWNER);
  t.false(archived.canContribute);
  t.true(archived.contributor);
});

test.serial("the selection bar leaves out Remove highlight over someone else's", (t) => {
  const action: SelectionAction = {
    nodeId: "n1",
    live: false,
    crossed: false,
    copyText: "memory",
    anchor: { exact: "memory" } as SelectionAction["anchor"],
    highlightIds: ["h2"],
    expandAnchor: null,
  };
  const props = {
    action,
    saving: false,
    branchBlocker: null,
    onBranch: () => {},
    onHighlight: () => {},
    onCopy: () => {},
    onDismiss: () => {},
  };
  // Without a selection in the document the bar is laid out hidden.
  const { rerender } = render(<SelectionToolbar {...props} />);
  t.truthy(screen.queryByText("Remove highlight"));
  rerender(<SelectionToolbar {...props} canChangeHighlights={false} />);
  t.is(screen.queryByText("Remove highlight"), null);
  t.truthy(screen.queryByText("Branch to right"));
  t.truthy(screen.queryByText("Copy"));
});

/* ------------------------------------------------------------- gating */

test.serial("a viewer reads without ask boxes, branching or edits", async (t) => {
  const { root, mine, content } = ownerAndMine();
  await mount({
    tree: { role: "viewer" },
    nodes: [root, { ...mine, authorId: OWNER }],
    contentByNode: content,
  });
  await waitUntil(t, () => screen.queryByText("Second answer.") !== null, "the answers load");
  t.is(screen.queryByRole("textbox", { name: "Follow-up in this conversation" }), null);
  const items = menuItems(await openMenuOf("And my follow-up?"));
  t.false(items.includes("Branch to right"), items.join("|"));
  t.false(items.includes("Rename…"));
  t.false(items.some((item) => item.startsWith("Delete")));
  t.false(items.includes("Rerun"));
  // The rows do not reorder.
  t.is(document.querySelector("[data-research-msg-row][data-research-card]"), null);
});

test.serial("a commenter asks and changes only what they wrote", async (t) => {
  const { root, mine, content } = ownerAndMine();
  await mount({ tree: { role: "commenter" }, nodes: [root, mine], contentByNode: content });
  await waitUntil(t, () => screen.queryByText("Second answer.") !== null, "the answers load");
  t.truthy(screen.getByRole("textbox", { name: "Follow-up in this conversation" }));

  const ownerItems = menuItems(await openMenuOf("What is collective memory?"));
  t.true(ownerItems.includes("Branch to right"));
  t.false(ownerItems.includes("Rerun"), "someone else's run is not theirs to pay for");
  // The root's Delete is the thread's, as on Home: their Trash, or Leave.
  t.true(ownerItems.includes("Delete research"), ownerItems.join("|"));
  fireEvent.click(screen.getByRole("menuitem", { name: "Delete research" }));
  const dialog = await waitFor(() => screen.getByRole("dialog", { name: /^Delete “/ }));
  t.truthy(
    within(dialog).getByText(
      "It moves to your Trash. Its owner and the other people in it still have it.",
    ),
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitUntil(t, () => screen.queryByRole("dialog") === null, "the dialog closes");

  const mineItems = menuItems(await openMenuOf("And my follow-up?"));
  t.true(
    mineItems.some((item) => item.startsWith("Delete")),
    mineItems.join("|"),
  );
  t.true(mineItems.includes("Rerun"));
  // Reordering is the owner's.
  t.is(document.querySelector("[data-research-msg-row][data-research-card]"), null);
});

test.serial("the owner reorders and gets the thread's sharing items", async (t) => {
  const { root, mine, content } = ownerAndMine();
  await mount({
    tree: { role: "owner", ownerId: ME },
    nodes: [{ ...root, authorId: ME }, mine],
    contentByNode: content,
  });
  await waitUntil(t, () => screen.queryByText("Second answer.") !== null, "the answers load");
  t.truthy(document.querySelector("[data-research-msg-row][data-research-card]"));
  fireEvent.click(screen.getByRole("button", { name: "Thread actions" }));
  const items = menuItems(
    await waitFor(() => screen.getByRole("menu", { name: "Answer actions" })),
  );
  t.true(items.includes("Share…"), items.join("|"));
  t.true(items.includes("Notify me"));
  t.true(items.includes("Rename…"));
});

/* ---------------------------------------------------------- attribution */

test.serial("author chips show when more than one person is in the thread", async (t) => {
  const { root, mine, content } = ownerAndMine();
  await mount({
    tree: { role: "commenter" },
    nodes: [root, mine],
    participants: PEOPLE,
    contentByNode: content,
  });
  await waitUntil(t, () => screen.queryByText("Second answer.") !== null, "the answers load");
  const messages = screen.getByRole("region", { name: /^Messages:/ });
  // The initial in front is the avatar of an account without a picture.
  t.regex(messages.querySelector(`[data-author-chip="${OWNER}"]`)?.textContent ?? "", /^A?Ada$/);
  t.regex(messages.querySelector(`[data-author-chip="${ME}"]`)?.textContent ?? "", /^R?You$/);
});

test.serial("no author chips in a thread of one", async (t) => {
  const { root, content } = ownerAndMine();
  await mount({
    tree: { role: "owner", ownerId: ME },
    nodes: [{ ...root, authorId: ME }],
    participants: [PEOPLE[1] as ResearchParticipant],
    contentByNode: content,
  });
  await waitUntil(t, () => screen.queryByText("Root answer.") !== null, "the answer loads");
  t.is(document.querySelector("[data-author-chip]"), null);
});

test.serial("Edited names the editor when it is not the author", async (t) => {
  await mount({
    tree: { role: "commenter" },
    nodes: [
      { ...post({ authorId: OWNER }), editedBy: "u2", editedAt: 1_700_000_100_000 } as ResearchNode,
    ],
    participants: PEOPLE,
  });
  const column = await waitFor(() => screen.getByRole("region", { name: /^Note:/ }));
  t.truthy(within(column).getByText("Edited by Grace"));
  t.regex(column.querySelector(`[data-author-chip="${OWNER}"]`)?.textContent ?? "", /^A?Ada$/);
});

/* ---------------------------------------------------------- share dialog */

const MEMBERS: ThreadMember[] = [
  {
    userId: ME,
    login: "raymond",
    name: "Raymond",
    avatarUrl: null,
    role: "owner",
    invitedBy: null,
    joinedAt: 0,
  },
  {
    userId: OWNER,
    login: "ada",
    name: "Ada",
    avatarUrl: null,
    role: "commenter",
    invitedBy: ME,
    joinedAt: 1,
  },
];

const LINK_INVITE: ThreadInvite = {
  id: "i1",
  treeId: "t1",
  role: "viewer",
  githubLogin: null,
  createdBy: ME,
  createdAt: 0,
  expiresAt: 1_800_000_000_000,
};

test.serial("the owner shares: visibility, members, invitations", async (t) => {
  const { root, content } = ownerAndMine();
  const { trpc } = await mount({
    tree: { role: "owner", ownerId: ME, visibility: "private" },
    nodes: [{ ...root, authorId: ME }],
    contentByNode: content,
    responses: {
      "sharing.listMembers": MEMBERS,
      "invites.list": [LINK_INVITE],
      "sharing.setVisibility": (input: { visibility: "public" | "private" }) =>
        tree({ ownerId: ME, role: "owner", visibility: input.visibility }),
      "sharing.removeMember": { ok: true },
      "invites.create": (input: { githubLogin?: string; role: "commenter" | "viewer" }) => ({
        invite: {
          ...LINK_INVITE,
          id: "i2",
          role: input.role,
          githubLogin: input.githubLogin ?? null,
        },
        token: "tok",
        url: "http://localhost/invite/tok",
      }),
      "invites.revoke": LINK_INVITE,
    },
  });
  await waitUntil(t, () => screen.queryByText("Root answer.") !== null, "the answer loads");
  fireEvent.click(screen.getByRole("button", { name: "Thread actions" }));
  fireEvent.click(await waitFor(() => screen.getByRole("menuitem", { name: "Share…" })));
  const dialog = await waitFor(() =>
    screen.getByRole("dialog", { name: "Share “Collective memory”" }),
  );
  await waitUntil(t, () => within(dialog).queryByText("Ada") !== null, "the members load");

  fireEvent.click(within(dialog).getByRole("radio", { name: /Public/ }));
  await waitUntil(
    t,
    () => trpc.calls.some((call) => call.path === "sharing.setVisibility"),
    "visibility is set",
  );
  t.deepEqual(trpc.calls.find((call) => call.path === "sharing.setVisibility")?.input, {
    treeId: "t1",
    visibility: "public",
  });

  fireEvent.change(within(dialog).getByRole("textbox", { name: "GitHub username" }), {
    target: { value: "@grace" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Invite" }));
  await waitUntil(
    t,
    () => trpc.calls.some((call) => call.path === "invites.create"),
    "the login invitation is created",
  );
  t.deepEqual(trpc.calls.find((call) => call.path === "invites.create")?.input, {
    treeId: "t1",
    role: "commenter",
    githubLogin: "grace",
  });

  fireEvent.click(within(dialog).getByRole("button", { name: "Copy invite link" }));
  await waitUntil(
    t,
    () => within(dialog).queryByRole("textbox", { name: "Invite link" }) !== null,
    "the link is shown",
  );
  const linkCall = trpc.calls.filter((call) => call.path === "invites.create")[1];
  t.deepEqual(linkCall?.input, { treeId: "t1", role: "commenter" });
  t.is(
    within(dialog).getByRole<HTMLInputElement>("textbox", { name: "Invite link" }).value,
    "http://localhost/invite/tok",
  );

  fireEvent.click(within(dialog).getByRole("button", { name: "Remove Ada" }));
  await waitUntil(
    t,
    () => trpc.calls.some((call) => call.path === "sharing.removeMember"),
    "the member is removed",
  );
  t.deepEqual(trpc.calls.find((call) => call.path === "sharing.removeMember")?.input, {
    treeId: "t1",
    userId: OWNER,
  });
  // A link invitation is still pending: it no longer admits the removed
  // member, but it admits anyone else.
  const notice = "Links you’ve shared still let new people join; revoke them to stop that.";
  await waitUntil(
    t,
    () => within(dialog).queryByText(notice) !== null,
    "the pending-link notice shows",
  );

  fireEvent.click(within(dialog).getByRole("button", { name: "Revoke Invite link" }));
  await waitUntil(
    t,
    () => trpc.calls.some((call) => call.path === "invites.revoke"),
    "the invitation is revoked",
  );
  await waitUntil(
    t,
    () => within(dialog).queryByText(notice) === null,
    "the notice goes with the last link",
  );
});

test.serial("removing a member with no pending links shows no link notice", async (t) => {
  const { root, content } = ownerAndMine();
  const { trpc } = await mount({
    tree: { role: "owner", ownerId: ME, visibility: "private" },
    nodes: [{ ...root, authorId: ME }],
    contentByNode: content,
    responses: {
      "sharing.listMembers": MEMBERS,
      "invites.list": [{ ...LINK_INVITE, githubLogin: "grace" }],
      "sharing.removeMember": { ok: true },
    },
  });
  await waitUntil(t, () => screen.queryByText("Root answer.") !== null, "the answer loads");
  fireEvent.click(screen.getByRole("button", { name: "Thread actions" }));
  fireEvent.click(await waitFor(() => screen.getByRole("menuitem", { name: "Share…" })));
  const dialog = await waitFor(() =>
    screen.getByRole("dialog", { name: "Share “Collective memory”" }),
  );
  await waitUntil(t, () => within(dialog).queryByText("@grace") !== null, "the invites load");
  fireEvent.click(within(dialog).getByRole("button", { name: "Remove Ada" }));
  await waitUntil(
    t,
    () => trpc.calls.some((call) => call.path === "sharing.removeMember"),
    "the member is removed",
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  t.is(within(dialog).queryByText(/Links you’ve shared/), null);
});

test.serial("a member sees the people read-only and can leave", async (t) => {
  const { root, content } = ownerAndMine();
  const members: ThreadMember[] = [
    { ...(MEMBERS[1] as ThreadMember), role: "owner", userId: OWNER, invitedBy: null },
    { ...(MEMBERS[0] as ThreadMember), role: "viewer", userId: ME, invitedBy: OWNER },
  ];
  const { trpc, router } = await mount({
    tree: { role: "viewer", visibility: "private" },
    nodes: [root],
    contentByNode: content,
    responses: { "sharing.listMembers": members, "sharing.leave": { ok: true } },
  });
  await waitUntil(t, () => screen.queryByText("Root answer.") !== null, "the answer loads");
  fireEvent.click(screen.getByRole("button", { name: "Thread actions" }));
  // Not the owner: the item and the dialog name the people, not sharing.
  fireEvent.click(await waitFor(() => screen.getByRole("menuitem", { name: "People…" })));
  const dialog = await waitFor(() =>
    screen.getByRole("dialog", { name: "People in “Collective memory”" }),
  );
  await waitUntil(t, () => within(dialog).queryByText("Ada") !== null, "the members load");
  t.is(within(dialog).queryByRole("radio"), null, "visibility is the owner's");
  t.truthy(within(dialog).getByText("Only its owner and the people it is shared with."));
  t.is(within(dialog).queryByRole("textbox", { name: "GitHub username" }), null);
  t.is(within(dialog).queryByRole("button", { name: /^Remove/ }), null);
  t.truthy(within(dialog).getByText("Viewer"));

  fireEvent.click(within(dialog).getByRole("button", { name: "Leave…" }));
  fireEvent.click(within(dialog).getByRole("button", { name: "Leave" }));
  await waitUntil(
    t,
    () => trpc.calls.some((call) => call.path === "sharing.leave"),
    "the member leaves",
  );
  await waitUntil(t, () => router.state.location.pathname === "/", "Home opens");
});

test.serial("Notify me follows the thread", async (t) => {
  const { root, content } = ownerAndMine();
  const { trpc } = await mount({
    tree: { role: "commenter" },
    nodes: [root],
    contentByNode: content,
    responses: {
      "subscriptions.set": (input: { value: boolean }) =>
        tree({ ownerId: OWNER, role: "commenter", followed: input.value }),
    },
  });
  await waitUntil(t, () => screen.queryByText("Root answer.") !== null, "the answer loads");
  fireEvent.click(screen.getByRole("button", { name: "Thread actions" }));
  fireEvent.click(await waitFor(() => screen.getByRole("menuitem", { name: "Notify me" })));
  await waitUntil(
    t,
    () => trpc.calls.some((call) => call.path === "subscriptions.set"),
    "the subscription is set",
  );
  t.deepEqual(trpc.calls.find((call) => call.path === "subscriptions.set")?.input, {
    treeId: "t1",
    value: true,
  });
  fireEvent.click(screen.getByRole("button", { name: "Thread actions" }));
  await waitUntil(
    t,
    () => screen.queryByRole("menuitem", { name: "Stop notifying me" }) !== null,
    "the menu offers to stop",
  );
});

/* -------------------------------------------------------------- presence */

test.serial("the thread header shows who else has it open", async (t) => {
  const { root, content } = ownerAndMine();
  const app = await mount({
    tree: { role: "commenter" },
    nodes: [root],
    contentByNode: content,
    responses: {
      "events.presence": [
        { userId: ME, login: "raymond", name: "Raymond", avatarUrl: null },
        { userId: OWNER, login: "ada", name: "Ada", avatarUrl: null },
      ],
    },
  });
  const viewers = await waitFor(() => screen.getByRole("img", { name: "Also viewing: Ada" }));
  t.truthy(viewers);
  act(() => {
    app.queryClient.setQueryData(queryKeys.presence("t1"), [
      { userId: ME, login: "raymond", name: "Raymond", avatarUrl: null },
    ]);
  });
  await waitUntil(
    t,
    () => screen.queryByRole("img", { name: /^Also viewing/ }) === null,
    "alone again",
  );
});

test.serial("an open thread is declared and renewed, and again when the tab shows", async (t) => {
  const stub = createTrpcStub();
  const published: string[][] = [];
  const bridge = connectEventBridge({
    queryClient: testQueryClient(),
    client: stub.client,
    renewIntervalMs: 40,
    setInterest: (_connectionId, _nodeIds, treeIds) => {
      published.push([...treeIds]);
      return Promise.resolve(undefined);
    },
  });
  stub.emit({ type: "connection.ready", payload: { connectionId: "c1" }, timestamp: 0 });
  const release = addTreeInterest("t1");
  await waitUntil(t, () => published.some((ids) => ids.includes("t1")), "declared");
  const declared = published.filter((ids) => ids.includes("t1")).length;
  await waitUntil(
    t,
    () => published.filter((ids) => ids.includes("t1")).length >= declared + 2,
    "renewed while open",
  );
  const before = published.length;
  document.dispatchEvent(new Event("visibilitychange"));
  t.true(published.length > before, "a shown tab declares it at once");
  release();
  await waitUntil(t, () => published.at(-1)?.length === 0, "closing the thread withdraws it");
  bridge.close();
});

/* ------------------------------------------------------------ tree events */

test("a tree event without the reader's own fields keeps them", (t) => {
  const cached = tree({ role: "commenter", followed: true, lastViewedAt: 5, title: "Old" });
  const incoming = tree({ title: "New" });
  delete (incoming as Partial<ResearchTree>).lastViewedAt;
  const merged = mergeTreeEvent(cached, incoming);
  t.is(merged.title, "New");
  t.is(merged.role, "commenter");
  t.true(merged.followed);
  t.is(merged.lastViewedAt, 5);

  const client = testQueryClient();
  client.setQueryData<ResearchTreeDetail>(queryKeys.tree("t1"), { tree: cached, nodes: [] });
  const event: SessionEvent = {
    type: "research.tree.updated",
    payload: { tree: incoming },
    timestamp: 1,
  };
  applyEventBatch([event], client);
  const detail = client.getQueryData<ResearchTreeDetail>(queryKeys.tree("t1"));
  t.is(detail?.tree.title, "New");
  t.is(detail?.tree.role, "commenter");
  t.true(detail?.tree.followed);
});

test("another person's tree event keeps the reader's own Archive and Trash", (t) => {
  // The server leaves a member's per-person state out of everyone else's
  // copy of a tree event (`research/access.ts:sharedTree`).
  const cached = tree({
    role: "commenter",
    archivedAt: 7,
    archivedBy: "owner",
    trashedAt: 9,
    trashedBy: ME,
  });
  const incoming = tree({ title: "Renamed" });
  for (const field of ["archivedAt", "trashedAt", "lastViewedAt"] as const) {
    delete (incoming as Partial<ResearchTree>)[field];
  }
  const merged = mergeTreeEvent(cached, incoming);
  t.is(merged.archivedAt, 7);
  t.is(merged.trashedAt, 9);
  t.is(merged.trashedBy, ME);
  t.is(merged.archivedBy, "owner");
  // The person who caused it gets their own copy, which speaks for itself.
  const own = mergeTreeEvent(cached, tree({ archivedAt: null, trashedAt: null }));
  t.is(own.archivedAt, null);
  t.is(own.trashedBy, undefined, "out of the Trash, trashedBy is not carried");
  t.is(own.archivedBy, undefined, "out of the Archive, archivedBy is not carried");

  const client = testQueryClient();
  const scope = { workspaceId: "w1", includeArchived: true };
  client.setQueryData<ResearchTreeDetail>(queryKeys.tree("t1"), { tree: cached, nodes: [] });
  client.setQueryData(queryKeys.trees(scope), [summary({ archivedAt: 7 })]);
  applyEventBatch(
    [{ type: "research.tree.updated", payload: { tree: incoming }, timestamp: 1 }],
    client,
  );
  t.is(client.getQueryData<ResearchTreeDetail>(queryKeys.tree("t1"))?.tree.archivedAt, 7);
  const row = client.getQueryData<ResearchTreeSummary[]>(queryKeys.trees(scope))?.[0];
  t.is(row?.title, "Renamed");
  t.is(row?.archivedAt, 7, "the summary keeps the reader's Archive too");
  t.false(client.getQueryState(queryKeys.tree("t1"))?.isInvalidated ?? false);

  // Another person's Archive or restore is read back from the server.
  applyEventBatch(
    [{ type: "research.tree.archived", payload: { tree: incoming }, timestamp: 2 }],
    client,
  );
  t.true(client.getQueryState(queryKeys.tree("t1"))?.isInvalidated);
});

test("a created thread is listed only for its owner, in its workspace", (t) => {
  const client = testQueryClient();
  client.setQueryData(queryKeys.me(), { id: ME });
  const w1 = queryKeys.trees({ workspaceId: "w1", includeArchived: false });
  const w2 = queryKeys.trees({ workspaceId: "w2", includeArchived: false });
  client.setQueryData(w1, []);
  client.setQueryData(w2, []);
  const created = (id: string, overrides: Partial<ResearchTree>) =>
    ({
      type: "research.tree.created",
      payload: {
        tree: tree({ id, rootNodeId: `${id}-root`, ...overrides }),
        node: node({ id: `${id}-root`, treeId: id, groupId: overrides.workspaceId ?? "w1" }),
      },
      timestamp: 1,
    }) satisfies SessionEvent;
  applyEventBatch(
    [
      created("own-w2", { workspaceId: "w2", ownerId: ME, role: "owner" }),
      created("theirs", { workspaceId: "w1", ownerId: OWNER }),
    ],
    client,
  );
  t.deepEqual(client.getQueryData<ResearchTreeSummary[]>(w1), []);
  t.deepEqual(
    client.getQueryData<ResearchTreeSummary[]>(w2)?.map((entry) => entry.id),
    ["own-w2"],
  );
});

test("presence and invitation events reach their caches", (t) => {
  const client = testQueryClient();
  const viewers = [{ userId: OWNER, login: "ada", name: "Ada", avatarUrl: null }];
  applyEventBatch(
    [{ type: "research.presence.changed", payload: { treeId: "t1", viewers }, timestamp: 1 }],
    client,
  );
  t.deepEqual(client.getQueryData(queryKeys.presence("t1")), viewers);
});

/* ------------------------------------------------------------ stale edit */

test.serial("a stale note edit offers the latest version and keeps the text", async (t) => {
  let stored = "A note about memory";
  const { trpc } = await mount({
    tree: { role: "owner", ownerId: ME },
    nodes: [post({ authorId: ME })],
    responses: {
      "research.getTree": () => ({
        tree: tree({ ownerId: ME, role: "owner" }),
        nodes: [post({ authorId: ME, text: stored })],
      }),
      "research.updatePost": (input: { expectedText: string }) => {
        if (input.expectedText !== stored) {
          throw conflict(
            "the note changed while you were editing; reopen the editor and try again",
          );
        }
        return {
          tree: tree({ ownerId: ME, role: "owner" }),
          node: post({ authorId: ME, text: "An edited note" }),
          removedHighlightCount: 0,
        };
      },
    },
  });
  const column = await waitFor(() => screen.getByRole("region", { name: /^Note:/ }));
  fireEvent.doubleClick(within(column).getByText("A note about memory"));
  const field = await waitFor(() => screen.getByRole("textbox", { name: "Note text" }));
  fireEvent.change(field, { target: { value: "An edited note" } });
  // Someone saves first.
  stored = "A newer note";
  fireEvent.click(screen.getByRole("button", { name: /^Save/ }));
  const prompt = await waitFor(() => screen.getByRole("dialog", { name: "This note changed" }));
  t.is(
    within(prompt).getByRole<HTMLTextAreaElement>("textbox", { name: "Your text" }).value,
    "An edited note",
  );
  fireEvent.click(within(prompt).getByRole("button", { name: "Reload latest version" }));
  await waitUntil(
    t,
    () => screen.queryByRole("dialog", { name: "This note changed" }) === null,
    "the prompt closes",
  );
  t.is(
    screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Note text" }).value,
    "An edited note",
    "the reader's text is kept",
  );
  fireEvent.click(screen.getByRole("button", { name: /^Save/ }));
  await waitUntil(
    t,
    () => trpc.calls.filter((call) => call.path === "research.updatePost").length === 2,
    "saved again",
  );
  t.like(trpc.calls.filter((call) => call.path === "research.updatePost")[1]?.input, {
    text: "An edited note",
    expectedText: "A newer note",
  });
});

/* -------------------------------------------------- shared with me, invite */

test.serial("Shared with me lists shared threads and accepts an invitation", async (t) => {
  const { router, trpc } = await renderApp("/shared", {
    queryClient: testQueryClient(),
    responses: {
      "workspaces.list": [
        { id: "w1", name: "Research", position: 0, createdAt: 0, updatedAt: 0, treeCount: 0 },
      ],
      "sharing.listShared": (input: { place: string }) =>
        input.place === "shared"
          ? [
              {
                ...tree({ id: "t9", title: "A shared thread", rootNodeId: "r9" }),
                type: "exchange",
                role: "commenter",
                ownerId: OWNER,
                runningCount: 0,
                failedCount: 0,
                completedCount: 1,
                nodeCount: 1,
                hasUnseenUpdate: false,
                hasUnseenFailure: false,
              },
            ]
          : [],
      "feed.recentQueriesForTrees": [],
      "invites.received": [
        {
          id: "i5",
          treeId: "t5",
          treeTitle: "An invited thread",
          role: "viewer",
          invitedBy: OWNER,
          invitedByLogin: "ada",
          createdAt: 0,
          expiresAt: 1_800_000_000_000,
        },
      ],
      "invites.accept": () => tree({ id: "t5", title: "An invited thread", role: "viewer" }),
      "research.getTree": () => ({ tree: tree({ id: "t5" }), nodes: [] }),
    },
  });
  await waitUntil(
    t,
    () => screen.queryByRole("heading", { name: "Shared with me", level: 1 }) !== null,
    "the place opens",
  );
  await waitUntil(t, () => screen.queryByText("A shared thread") !== null, "the shared card");
  t.truthy(screen.getByText("From @ada · Viewer"));
  fireEvent.click(
    screen.getByRole("button", { name: "Accept the invitation to An invited thread" }),
  );
  await waitUntil(t, () => router.state.location.pathname === "/r/t5", "the accepted thread opens");
  t.deepEqual(trpc.calls.find((call) => call.path === "invites.accept")?.input, {
    inviteId: "i5",
  });
});

test.serial("an invitation link accepts and opens the thread", async (t) => {
  const { router, trpc } = await renderApp("/invite/tok-1", {
    queryClient: testQueryClient(),
    responses: {
      "invites.accept": () => tree({ id: "t7", role: "commenter" }),
      "research.getTree": () => ({ tree: tree({ id: "t7" }), nodes: [] }),
    },
  });
  await waitUntil(t, () => router.state.location.pathname === "/r/t7", "the thread opens");
  t.deepEqual(trpc.calls.find((call) => call.path === "invites.accept")?.input, {
    token: "tok-1",
  });
});

test.serial("an invalid invitation says why", async (t) => {
  await renderApp("/invite/gone", {
    queryClient: testQueryClient(),
    responses: {
      "invites.accept": () => {
        throw new Error("This invitation was not found, has expired or was revoked.");
      },
    },
  });
  const alert = await waitFor(() => screen.getByRole("alert"));
  t.is(alert.textContent, "This invitation was not found, has expired or was revoked.");
  t.truthy(screen.getByRole("heading", { name: "This invitation can’t be used" }));
});

test.serial("signed out, an invitation link signs in first", async (t) => {
  const { router } = await renderApp("/invite/tok-2", {
    user: null,
    queryClient: testQueryClient(),
    responses: { "feed.recentActivity": { items: [], nextCursor: null } },
  });
  await waitUntil(t, () => router.state.location.pathname === "/login", "sign-in opens");
  t.is(
    (router.state.location.search as { redirect?: string }).redirect,
    "/invite/tok-2",
    "and comes back to the invitation",
  );
});
