// Changes made by a thread's owner while other people have the thread open
// (`07-client-architecture.md` §4.2): a role change, Archive, Make private,
// Trash and removal reach the open pages through events, without a reload;
// presence avatars follow who has the thread open; a public thread's reader
// outside the event audience, and a guest, re-read it on coming back. Each
// person has a browser context of their own; the owner's changes go through
// the API.

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { completedThread, mutation, query, signedInContext, type Detail } from "./helpers.js";

const THREAD_UNAVAILABLE = "This thread was deleted or is no longer shared with you.";
const ARCHIVED_NOTE =
  "Archived questions are read-only. Move the question out of Archive to continue.";

/** The root conversation's ask box. */
function rootComposer(page: Page) {
  return page.getByRole("textbox", { name: "Follow-up in this conversation" });
}

/** The avatars in the thread's header naming who else has it open. */
function presence(page: Page) {
  return page.locator("[data-research-presence]");
}

/** Opens the thread and waits for its question. */
async function openThread(page: Page, treeId: string, prompt: string): Promise<void> {
  await page.goto(`/r/${treeId}`);
  await expect(page.getByText(prompt).first()).toBeVisible();
}

/** The unavailable state the thread page shows once a refetch is refused. */
async function expectUnavailable(page: Page): Promise<void> {
  await expect(page.getByRole("heading", { name: "Research unavailable" })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveText(THREAD_UNAVAILABLE);
}

/** Makes `member` a member of the owner's thread through an invitation link. */
async function addMember(
  owner: APIRequestContext,
  member: APIRequestContext,
  treeId: string,
  role: "commenter" | "viewer",
): Promise<void> {
  const link = await mutation<{ token: string }>(owner, "invites.create", { treeId, role });
  await mutation(member, "invites.accept", { token: link.token });
}

/** Leaves the thread for Home through the sidebar, inside the app. */
async function goHome(page: Page): Promise<void> {
  await page
    .getByRole("navigation", { name: "Research" })
    .getByRole("link", { name: "Home" })
    .click();
  await expect(page.getByRole("heading", { name: "Home", level: 1 })).toBeVisible();
}

test("a commenter made a viewer while the thread is open loses the ask box and their queued follow-up", async ({
  browser,
}) => {
  const owner = await signedInContext(browser, "e2e-live-role-owner");
  const member = await signedInContext(browser, "e2e-live-role-member");
  try {
    const prompt = "What happens to a queue when its asker becomes a viewer?";
    const detail = await completedThread(owner.page, prompt);
    const treeId = detail.tree.id;
    const rootId = detail.nodes[0]!.id;
    await addMember(owner.request, member.request, treeId, "commenter");
    await openThread(member.page, treeId, prompt);
    await expect(rootComposer(member.page)).toBeVisible();

    // The owner asks a follow-up that answers slowly, so the member's
    // question queues behind it.
    const asked = await mutation<{ kind: string; node?: { id: string } }>(
      owner.request,
      "followups.ask",
      { headNodeId: rootId, prompt: "fixture:paced-answer A slow answer to queue behind" },
    );
    expect(asked.kind).toBe("sent");
    await expect(rootComposer(member.page)).toHaveAttribute("placeholder", "Queue a follow-up");
    const queuedText = "A follow-up the member queued";
    await rootComposer(member.page).fill(queuedText);
    await member.page.getByRole("button", { name: "Queue", exact: true }).click();
    const queued = member.page.locator("[data-research-queued]");
    await expect(queued).toContainText(queuedText);

    // Stopping the owner's answer holds the queue, so the item cannot be sent
    // before the role changes.
    await mutation(owner.request, "research.cancelNode", { nodeId: asked.node!.id });
    await expect(queued).toContainText("Not sent");

    await mutation(owner.request, "sharing.setRole", {
      treeId,
      userId: member.user.id,
      role: "viewer",
    });
    await expect(rootComposer(member.page)).toHaveCount(0);
    await expect(queued).toHaveCount(0);
    // The thread stays readable, and the dropped item was never sent.
    await expect(member.page.getByText(prompt).first()).toBeVisible();
    const after = await query<Detail>(owner.request, "research.getTree", { treeId });
    expect(Object.values(after.queues ?? {}).flat()).toHaveLength(0);
    await expect(member.page.getByText(queuedText)).toHaveCount(0);
  } finally {
    await Promise.all([owner.context.close(), member.context.close()]);
  }
});

test("Archive and Make private reach a member and a public reader with the thread open", async ({
  browser,
}) => {
  const owner = await signedInContext(browser, "e2e-live-archive-owner");
  const member = await signedInContext(browser, "e2e-live-archive-member");
  const reader = await signedInContext(browser, "e2e-live-archive-reader");
  try {
    const prompt = "What does an archived shared thread look like to others?";
    const detail = await completedThread(owner.page, prompt);
    const treeId = detail.tree.id;
    await addMember(owner.request, member.request, treeId, "commenter");
    await mutation(owner.request, "sharing.setVisibility", { treeId, visibility: "public" });

    await openThread(owner.page, treeId, prompt);
    await openThread(member.page, treeId, prompt);
    await openThread(reader.page, treeId, prompt);
    // Both show in the owner's header once the server has their open-thread
    // declarations, so the reader is in the thread's event audience.
    await expect(presence(owner.page)).toHaveAttribute(
      "aria-label",
      new RegExp(`^Also viewing: .*${member.user.login}`),
    );
    await expect(presence(owner.page)).toHaveAttribute(
      "aria-label",
      new RegExp(`^Also viewing: .*${reader.user.login}`),
    );

    // Archive: the member's ask box turns read-only; the reader keeps reading.
    await mutation(owner.request, "research.archiveTree", { treeId });
    await expect(member.page.getByText(ARCHIVED_NOTE)).toBeVisible();
    await expect(rootComposer(member.page)).toBeDisabled();
    await expect(reader.page.getByText(prompt).first()).toBeVisible();
    await expect(reader.page.getByRole("heading", { name: "Research unavailable" })).toHaveCount(0);

    // Make private: the reader, who is not a member, loses the thread; the
    // member keeps it.
    await mutation(owner.request, "sharing.setVisibility", { treeId, visibility: "private" });
    await expectUnavailable(reader.page);
    await expect(member.page.getByText(prompt).first()).toBeVisible();
    await expect(member.page.getByText(ARCHIVED_NOTE)).toBeVisible();
    // The reader no longer shows as viewing it.
    await expect(presence(owner.page)).toHaveAttribute(
      "aria-label",
      `Also viewing: ${member.user.login}`,
    );
  } finally {
    await Promise.all([owner.context.close(), member.context.close(), reader.context.close()]);
  }
});

test("Trash reaches a member and a public reader with the thread open", async ({ browser }) => {
  const owner = await signedInContext(browser, "e2e-live-trash-owner");
  const member = await signedInContext(browser, "e2e-live-trash-member");
  const reader = await signedInContext(browser, "e2e-live-trash-reader");
  try {
    const prompt = "Who still sees a thread its owner moved to the Trash?";
    const detail = await completedThread(owner.page, prompt);
    const treeId = detail.tree.id;
    await addMember(owner.request, member.request, treeId, "viewer");
    await mutation(owner.request, "sharing.setVisibility", { treeId, visibility: "public" });

    await openThread(owner.page, treeId, prompt);
    await openThread(member.page, treeId, prompt);
    await openThread(reader.page, treeId, prompt);
    await expect(presence(owner.page)).toHaveAttribute(
      "aria-label",
      new RegExp(`^Also viewing: .*${reader.user.login}`),
    );

    await mutation(owner.request, "research.trashTree", { treeId });
    await expectUnavailable(member.page);
    await expectUnavailable(reader.page);
  } finally {
    await Promise.all([owner.context.close(), member.context.close(), reader.context.close()]);
  }
});

test("a member removed while viewing sees the thread as unavailable and leaves the presence avatars", async ({
  browser,
}) => {
  const owner = await signedInContext(browser, "e2e-live-remove-owner");
  const member = await signedInContext(browser, "e2e-live-remove-member");
  try {
    const prompt = "What does a removed member see on the open thread?";
    const detail = await completedThread(owner.page, prompt);
    const treeId = detail.tree.id;
    await addMember(owner.request, member.request, treeId, "commenter");

    await openThread(owner.page, treeId, prompt);
    await expect(presence(owner.page)).toHaveCount(0);
    await openThread(member.page, treeId, prompt);
    await expect(presence(owner.page)).toHaveAttribute(
      "aria-label",
      `Also viewing: ${member.user.login}`,
    );
    await expect(presence(member.page)).toHaveAttribute(
      "aria-label",
      `Also viewing: ${owner.user.login}`,
    );

    await mutation(owner.request, "sharing.removeMember", { treeId, userId: member.user.id });
    await expectUnavailable(member.page);
    await expect(presence(owner.page)).toHaveCount(0);
  } finally {
    await Promise.all([owner.context.close(), member.context.close()]);
  }
});

test("presence avatars appear while another person has the thread open and go when they leave", async ({
  browser,
}) => {
  const owner = await signedInContext(browser, "e2e-live-presence-owner");
  const member = await signedInContext(browser, "e2e-live-presence-member");
  try {
    const prompt = "Who else has this thread open?";
    const detail = await completedThread(owner.page, prompt);
    const treeId = detail.tree.id;
    await addMember(owner.request, member.request, treeId, "viewer");
    await openThread(owner.page, treeId, prompt);
    await expect(presence(owner.page)).toHaveCount(0);

    await openThread(member.page, treeId, prompt);
    const avatars = presence(owner.page);
    await expect(avatars).toHaveAttribute("aria-label", `Also viewing: ${member.user.login}`);

    // Going elsewhere in the app withdraws the declaration.
    await goHome(member.page);
    await expect(avatars).toHaveCount(0);

    // Coming back declares it again; closing the tab ends the connection.
    await member.page.goBack();
    await expect(member.page.getByText(prompt).first()).toBeVisible();
    await expect(avatars).toHaveAttribute("aria-label", `Also viewing: ${member.user.login}`);
    await member.page.close();
    await expect(avatars).toHaveCount(0);
  } finally {
    await Promise.all([owner.context.close(), member.context.close()]);
  }
});

test("a public reader and a guest coming back to a thread see the question asked meanwhile", async ({
  browser,
}) => {
  const owner = await signedInContext(browser, "e2e-live-reopen-owner");
  const reader = await signedInContext(browser, "e2e-live-reopen-reader");
  const guestContext = await browser.newContext();
  try {
    const prompt = "Does a returning reader see new questions?";
    const detail = await completedThread(owner.page, prompt);
    const treeId = detail.tree.id;
    await mutation(owner.request, "sharing.setVisibility", { treeId, visibility: "public" });

    await openThread(owner.page, treeId, prompt);
    await openThread(reader.page, treeId, prompt);
    const guest = await guestContext.newPage();
    await openThread(guest, treeId, prompt);
    await expect(presence(owner.page)).toHaveAttribute(
      "aria-label",
      `Also viewing: ${reader.user.login}`,
    );

    // The reader leaves for Home inside the app, keeping the cached thread;
    // once the owner's header drops them, the server no longer sends them the
    // thread's events.
    await goHome(reader.page);
    await expect(presence(owner.page)).toHaveCount(0);
    await guest.getByRole("link", { name: "Home" }).first().click();
    await guest.waitForURL((url) => !url.pathname.startsWith("/r/"));

    const followUp = "A question asked while the reader was away";
    await mutation(owner.request, "followups.ask", {
      headNodeId: detail.nodes[0]!.id,
      prompt: followUp,
    });
    await expect(owner.page.getByText(followUp).first()).toBeVisible();

    // Back to the thread: the page re-reads it instead of showing the copy
    // cached before the question.
    await reader.page.goBack();
    await expect(reader.page.getByText(prompt).first()).toBeVisible();
    await expect(reader.page.getByText(followUp).first()).toBeVisible();
    await guest.goBack();
    await expect(guest.getByText(prompt).first()).toBeVisible();
    await expect(guest.getByText(followUp).first()).toBeVisible();
  } finally {
    await Promise.all([owner.context.close(), reader.context.close(), guestContext.close()]);
  }
});
