// Unsent browser draft state is scoped to the author account: composer drafts
// (`stores/drafts.ts`, sessionStorage) and unsent branches
// (`features/thread/persistence.ts`, localStorage) are cleared on sign-out,
// hidden during session expiration for the same account, and isolated from
// guest sessions and other authenticated accounts.

import { cleanup, fireEvent, screen } from "@testing-library/react";
import test, { type ExecutionContext } from "ava";

import { connectEventBridge } from "../src/api/events.js";
import {
  flushThreadNavigation,
  recordPendingBranch,
  resetThreadNavigationForTests,
  savedPendingBranch,
  THREAD_NAVIGATION_KEY,
} from "../src/features/thread/persistence.js";
import { LOCAL_OWNER_KEY } from "../src/lib/localOwner.js";
import {
  DRAFT_SYNC_DEBOUNCE_MS,
  DRAFTS_STORAGE_KEY,
  homeDraftKey,
  nodeDraftKey,
  useDraftsStore,
} from "../src/stores/drafts.js";
import { onLocalOwnerChanged } from "../src/stores/localAccount.js";

import { summary } from "./fixtures.js";
import { renderApp, testUser, waitUntil } from "./helpers.js";
import { serverSettings, testQueryClient, workspace, WORKSPACE_ID } from "./phase6Fixtures.js";
import { createTrpcStub } from "./trpcStub.js";

const ANCHOR = {
  version: 1 as const,
  projection: "answer-v1" as const,
  responseRevision: "a".repeat(64),
  start: 0,
  end: 5,
  exact: "Alpha",
  prefix: "",
  suffix: " beta",
};

const FIELD = "New question";
const HOME_DRAFT = "Account A's unsent question";
const ROOT_DRAFT = "Account A's follow-up on a shared thread";
const BRANCH_DRAFT = "Account A's unsent branch";

const homeResponses: Record<string, unknown> = {
  "workspaces.list": [workspace()],
  "settings.get": serverSettings(),
  "research.listTrees": [summary({ workspaceId: WORKSPACE_ID })],
  "folders.get": { folders: [], membership: {}, collapsed: [], parents: {}, collapsedGroups: [] },
  "drafts.list": [],
  "research.listTrash": [],
  "feed.recentQueriesForTrees": [],
  "highlights.listFeed": [],
  "auth.logout": { ok: true },
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Populates Account A draft data in home composer, thread root composer, and branch state. */
function writeAccountADrafts(): void {
  const drafts = useDraftsStore.getState();
  drafts.setDraft(homeDraftKey(WORKSPACE_ID), { text: HOME_DRAFT });
  drafts.setDraft(nodeDraftKey("tree:t1"), { text: ROOT_DRAFT });
  recordPendingBranch("t1", "n1", ANCHOR, BRANCH_DRAFT);
  flushThreadNavigation();
}

function assertNoAccountAText(t: ExecutionContext, when: string): void {
  const stored = `${sessionStorage.getItem(DRAFTS_STORAGE_KEY) ?? ""}${
    localStorage.getItem(THREAD_NAVIGATION_KEY) ?? ""
  }`;
  for (const text of [HOME_DRAFT, ROOT_DRAFT, BRANCH_DRAFT]) {
    t.false(stored.includes(text), `${when}: storage holds "${text}"`);
  }
  t.deepEqual(useDraftsStore.getState().byKey, {}, `${when}: no drafts in memory`);
  t.is(savedPendingBranch("t1", "n1"), null, `${when}: no unsent branch`);
}

function sentAccountAText(calls: { path: string; input: unknown }[]): boolean {
  return calls.some(
    (call) =>
      call.path === "interfaceDrafts.set" &&
      [HOME_DRAFT, ROOT_DRAFT].some((text) => JSON.stringify(call.input).includes(text)),
  );
}

async function openHome(t: ExecutionContext, user = testUser(), responses = {}) {
  const app = await renderApp("/", {
    user,
    queryClient: testQueryClient(),
    responses: { ...homeResponses, ...responses },
  });
  await waitUntil(t, () => screen.queryByRole("textbox", { name: FIELD }) !== null, "the ask box");
  return app;
}

test.beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  useDraftsStore.setState({ byKey: {} });
  resetThreadNavigationForTests();
});

// A failed test leaves its app mounted; the next one starts without it.
test.afterEach.always(() => cleanup());

test.serial("signing out clears unsent drafts and branches in local storage", async (t) => {
  const app = await openHome(t);
  writeAccountADrafts();
  await sleep(DRAFT_SYNC_DEBOUNCE_MS + 20);

  fireEvent.click(screen.getByText("raymond"));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Sign out" }));
  await waitUntil(
    t,
    () => app.trpc.calls.some((call) => call.path === "auth.logout"),
    "the sign-out request",
  );
  await waitUntil(
    t,
    () => Object.keys(useDraftsStore.getState().byKey).length === 0,
    "drafts store is empty",
  );
  assertNoAccountAText(t, "after signing out");
  app.unmount();
});

test.serial(
  "authenticating as a different account isolates previous drafts and loads server drafts without shadowing",
  async (t) => {
    const first = await openHome(t);
    writeAccountADrafts();
    first.unmount();

    // Account B's own Home draft on the server, older than A's local one.
    const ownDraft = JSON.stringify({ text: "Account B's saved question", updatedAt: 1 });
    const second = await openHome(t, testUser({ id: "u2", login: "other" }), {
      "interfaceDrafts.get": (input: { key: string }) => ({
        key: input.key,
        value: input.key === homeDraftKey(WORKSPACE_ID) ? ownDraft : null,
      }),
    });
    await waitUntil(
      t,
      () =>
        screen.getByRole<HTMLTextAreaElement>("textbox", { name: FIELD }).value ===
        "Account B's saved question",
      "account B server draft is displayed",
    );
    await sleep(DRAFT_SYNC_DEBOUNCE_MS + 20);
    t.false(sentAccountAText(second.trpc.calls), "A's drafts are not written to B's account");
    t.false(
      [ROOT_DRAFT, BRANCH_DRAFT, HOME_DRAFT].some((text) =>
        `${sessionStorage.getItem(DRAFTS_STORAGE_KEY) ?? ""}${
          localStorage.getItem(THREAD_NAVIGATION_KEY) ?? ""
        }`.includes(text),
      ),
      "account A drafts are removed from storage",
    );
    t.is(savedPendingBranch("t1", "n1"), null, "A's unsent branch is gone");
    t.is(useDraftsStore.getState().get(nodeDraftKey("tree:t1")), undefined);
    second.unmount();
  },
);

test.serial("guest session does not access previous account drafts", async (t) => {
  const first = await openHome(t);
  writeAccountADrafts();
  first.unmount();
  const guest = await renderApp("/", {
    user: null,
    queryClient: testQueryClient(),
    responses: homeResponses,
  });
  await sleep(20);
  t.is(
    useDraftsStore.getState().get(homeDraftKey(WORKSPACE_ID)),
    undefined,
    "no Home draft as a guest",
  );
  t.is(
    useDraftsStore.getState().get(nodeDraftKey("tree:t1")),
    undefined,
    "no thread draft as a guest",
  );
  t.is(savedPendingBranch("t1", "n1"), null, "no unsent branch as a guest");
  guest.unmount();
});

test.serial("the same account keeps its drafts across a reload", async (t) => {
  const first = await openHome(t);
  writeAccountADrafts();
  first.unmount();
  const second = await openHome(t);
  t.is(screen.getByRole<HTMLTextAreaElement>("textbox", { name: FIELD }).value, HOME_DRAFT);
  t.is(useDraftsStore.getState().get(nodeDraftKey("tree:t1"))?.text, ROOT_DRAFT);
  t.is(savedPendingBranch("t1", "n1")?.text, BRANCH_DRAFT);
  second.unmount();
});

test.serial(
  "expired session preserves unsent drafts and branches for re-authentication by the same account",
  async (t) => {
    const app = await openHome(t);
    writeAccountADrafts();
    app.unmount();
    const stub = createTrpcStub();
    let signedOut = 0;
    const bridge = connectEventBridge({
      queryClient: testQueryClient(),
      client: stub.client,
      setInterest: () => Promise.resolve(undefined),
      onUnauthorized: () => (signedOut += 1),
    });
    for (const observer of stub.observers) observer.onError?.({ data: { code: "UNAUTHORIZED" } });
    t.is(signedOut, 1);
    // Inactive while signed out: inaccessible to reads and writes.
    t.is(useDraftsStore.getState().get(homeDraftKey(WORKSPACE_ID)), undefined);
    t.is(savedPendingBranch("t1", "n1"), null);
    t.true(
      (sessionStorage.getItem(DRAFTS_STORAGE_KEY) ?? "").includes(HOME_DRAFT),
      "the drafts stay stored",
    );
    t.true(
      (localStorage.getItem(THREAD_NAVIGATION_KEY) ?? "").includes(BRANCH_DRAFT),
      "the branch stays stored",
    );
    bridge.close();
    // Re-authenticating as the same account restores access to unsent drafts.
    const again = await openHome(t);
    t.is(screen.getByRole<HTMLTextAreaElement>("textbox", { name: FIELD }).value, HOME_DRAFT);
    t.is(useDraftsStore.getState().get(nodeDraftKey("tree:t1"))?.text, ROOT_DRAFT);
    t.is(savedPendingBranch("t1", "n1")?.text, BRANCH_DRAFT);
    again.unmount();
  },
);

test.serial(
  "when another tab changes authenticated user, current tab discards pending draft writes and reloads",
  async (t) => {
    const app = await openHome(t);
    // Unsent edits still inside their debounce.
    useDraftsStore.getState().setDraft(homeDraftKey(WORKSPACE_ID), { text: HOME_DRAFT });
    recordPendingBranch("t1", "n1", ANCHOR, BRANCH_DRAFT);

    // Another tab updates local owner to account B before storage event sync occurs.
    const recorded = JSON.stringify({ userId: "u2" });
    localStorage.setItem(LOCAL_OWNER_KEY, recorded);
    const othersState = JSON.stringify({ t2: { scroll: {}, updatedAt: 1 } });
    localStorage.setItem(THREAD_NAVIGATION_KEY, othersState);

    flushThreadNavigation();
    useDraftsStore.getState().flush();
    t.is(localStorage.getItem(THREAD_NAVIGATION_KEY), othersState, "the branch is not written");
    t.false(sentAccountAText(app.trpc.calls), "draft is not synced to different account");

    let reloads = 0;
    onLocalOwnerChanged(recorded, () => (reloads += 1));
    t.is(reloads, 1, "the tab reloads for the other session");
    t.deepEqual(useDraftsStore.getState().byKey, {});
    t.is(savedPendingBranch("t1", "n1"), null);
    await sleep(DRAFT_SYNC_DEBOUNCE_MS + 20);
    t.false(sentAccountAText(app.trpc.calls));
    app.unmount();
  },
);

test.serial(
  "storage event for current account ID does not trigger reload or state changes",
  async (t) => {
    const app = await openHome(t);
    writeAccountADrafts();
    let reloads = 0;
    onLocalOwnerChanged(JSON.stringify({ userId: "u1" }), () => (reloads += 1));
    onLocalOwnerChanged(null, () => (reloads += 1));
    t.is(reloads, 0);
    t.is(useDraftsStore.getState().get(homeDraftKey(WORKSPACE_ID))?.text, HOME_DRAFT);
    t.is(savedPendingBranch("t1", "n1")?.text, BRANCH_DRAFT);
    app.unmount();
  },
);
