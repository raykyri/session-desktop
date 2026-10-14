// Sharing a thread between accounts and a guest, each in its own browser
// context (`02-domain-model-and-database.md` §5.16). The first tests go
// through the sharing UI: the Share dialog's invite links, a commenter's
// question seen live by the owner, a viewer's and a guest's read-only page,
// and the stale-edit prompt. The rest drive the server through its tRPC
// endpoint with each context's own session cookie.

import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";

import { APP_ORIGIN } from "./constants.js";
import { signIn } from "./helpers.js";

const MUTATION_HEADERS = { "x-requested-with": "session", "content-type": "application/json" };

async function mutation<T>(request: APIRequestContext, path: string, input: unknown): Promise<T> {
  const response = await request.post(`${APP_ORIGIN}/api/trpc/${path}`, {
    headers: MUTATION_HEADERS,
    data: input ?? {},
  });
  expect(response.ok(), `${path}: ${response.status()} ${await response.text()}`).toBe(true);
  return ((await response.json()) as { result: { data: T } }).result.data;
}

/** A mutation expected to fail, answering with its tRPC error code. */
async function refusal(request: APIRequestContext, path: string, input: unknown): Promise<string> {
  const response = await request.post(`${APP_ORIGIN}/api/trpc/${path}`, {
    headers: MUTATION_HEADERS,
    data: input ?? {},
  });
  expect(response.ok(), `${path} should be refused`).toBe(false);
  return ((await response.json()) as { error: { data: { code: string } } }).error.data.code;
}

async function query<T>(request: APIRequestContext, path: string, input: unknown): Promise<T> {
  const search = input === undefined ? "" : `?input=${encodeURIComponent(JSON.stringify(input))}`;
  const response = await request.get(`${APP_ORIGIN}/api/trpc/${path}${search}`);
  expect(response.ok(), `${path}: ${response.status()} ${await response.text()}`).toBe(true);
  return ((await response.json()) as { result: { data: T } }).result.data;
}

interface Detail {
  tree: { id: string; role?: string };
  nodes: { id: string; authorId?: string | null; run?: { status: string } }[];
}

async function signedInContext(browser: Browser, login: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const user = await signIn(page, { login });
  return { context, page, user, request: page.request };
}

/** A thread whose root answer has completed. */
async function completedThread(page: Page, prompt: string): Promise<Detail> {
  const workspace = await mutation<{ id: string }>(page.request, "workspaces.ensureDefault", {});
  const detail = await mutation<Detail>(page.request, "research.createTree", {
    prompt,
    model: "gemini-flash",
    workspaceId: workspace.id,
  });
  await expect
    .poll(
      async () =>
        (await query<Detail>(page.request, "research.getTree", { treeId: detail.tree.id })).nodes[0]
          ?.run?.status,
    )
    .toBe("complete");
  return detail;
}

/** Opens the root's menu and the Share dialog on a thread page. */
async function openShareDialog(page: Page) {
  await page.getByRole("button", { name: "Thread actions" }).click();
  await page.getByRole("menuitem", { name: "Share…" }).click();
  return page.getByRole("dialog", { name: /^Share “/ });
}

/** Copies an invite link from the open Share dialog and reads it back. */
async function copyInviteLink(dialog: ReturnType<Page["getByRole"]>): Promise<string> {
  const field = dialog.getByRole("textbox", { name: "Invite link" });
  const before = (await field.count()) > 0 ? await field.inputValue() : "";
  await dialog.getByRole("button", { name: "Copy invite link" }).click();
  await expect(field).not.toHaveValue(before);
  return field.inputValue();
}

test("the owner shares by link; the commenter asks, live for the owner; the viewer only reads", async ({
  browser,
}) => {
  const owner = await signedInContext(browser, "e2e-ui-owner");
  const commenter = await signedInContext(browser, "e2e-ui-commenter");
  const viewer = await signedInContext(browser, "e2e-ui-viewer");
  try {
    const prompt = "What does sharing through the dialog look like?";
    const detail = await completedThread(owner.page, prompt);
    const treeId = detail.tree.id;
    await owner.page.goto(`/r/${treeId}`);
    await expect(owner.page.getByText(prompt).first()).toBeVisible();

    const dialog = await openShareDialog(owner.page);
    await expect(dialog.locator('[data-share-member="e2e-ui-owner"]')).toContainText("Owner");
    const commenterLink = await copyInviteLink(dialog);
    expect(commenterLink).toMatch(/\/invite\/[^/]+$/);
    await dialog.getByRole("combobox", { name: "Role for the invitation" }).click();
    await owner.page.getByRole("option", { name: /^Viewer/ }).click();
    const viewerLink = await copyInviteLink(dialog);
    expect(viewerLink).not.toBe(commenterLink);
    await expect(dialog.getByRole("list").filter({ hasText: "Invite link" })).toBeVisible();
    await dialog.getByRole("button", { name: "Done" }).click();

    // The commenter accepts the link and lands on the thread.
    await commenter.page.goto(new URL(commenterLink).pathname);
    await commenter.page.waitForURL(new RegExp(`/r/${treeId}`));
    const before = await query<{ runs: number }>(commenter.request, "usage.summary", undefined);
    const field = commenter.page.getByRole("textbox", { name: "Follow-up in this conversation" });
    await field.click();
    const question = "A question from the commenter";
    await field.fill(question);
    await commenter.page.keyboard.press("ControlOrMeta+Enter");
    await expect(commenter.page.getByText(question).first()).toBeVisible();
    // Asker pays.
    await expect
      .poll(
        async () =>
          (await query<{ runs: number }>(commenter.request, "usage.summary", undefined)).runs,
      )
      .toBe(before.runs + 1);

    // The owner sees the commenter's question arrive without reloading,
    // credited to them, and opens its answer.
    const row = owner.page.locator("[data-research-msg-row]", { hasText: question });
    await expect(row).toBeVisible();
    await expect(row.locator("[data-author-chip]")).toContainText("e2e-ui-commenter");
    await row.locator("[data-research-row]").click();
    await expect(owner.page.locator("[data-research-response-root]").last()).not.toBeEmpty({
      timeout: 60_000,
    });

    // The viewer reads and cannot ask.
    await viewer.page.goto(new URL(viewerLink).pathname);
    await viewer.page.waitForURL(new RegExp(`/r/${treeId}`));
    await expect(viewer.page.getByText(prompt).first()).toBeVisible();
    await expect(viewer.page.getByText(question).first()).toBeVisible();
    await expect(
      viewer.page.getByRole("textbox", { name: "Follow-up in this conversation" }),
    ).toHaveCount(0);
    const people = await openShareDialog(viewer.page);
    await expect(people.locator('[data-share-member="e2e-ui-viewer"]')).toContainText("Viewer");
    await expect(people.getByRole("radio")).toHaveCount(0);
  } finally {
    await Promise.all([owner.context.close(), commenter.context.close(), viewer.context.close()]);
  }
});

test("a removed member cannot rejoin through an earlier link; a new link lets them back", async ({
  browser,
}) => {
  const owner = await signedInContext(browser, "e2e-ui-remove-owner");
  const member = await signedInContext(browser, "e2e-ui-removed");
  const newcomer = await signedInContext(browser, "e2e-ui-newcomer");
  try {
    const prompt = "Can a removed member come back through a link?";
    const detail = await completedThread(owner.page, prompt);
    const treeId = detail.tree.id;
    await owner.page.goto(`/r/${treeId}`);
    await expect(owner.page.getByText(prompt).first()).toBeVisible();
    const dialog = await openShareDialog(owner.page);
    const link = await copyInviteLink(dialog);

    await member.page.goto(new URL(link).pathname);
    await member.page.waitForURL(new RegExp(`/r/${treeId}`));

    // The owner removes them while the link is still pending.
    const row = dialog.locator('[data-share-member="e2e-ui-removed"]');
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: /^Remove / }).click();
    await expect(row).toHaveCount(0);
    await expect(dialog.locator("[data-share-link-notice]")).toHaveText(
      "Links you’ve shared still let new people join; revoke them to stop that.",
    );

    // The link no longer lets them in, but it still lets someone else in.
    await member.page.goto(new URL(link).pathname);
    await expect(member.page.getByRole("alert")).toHaveText("You were removed from this thread.");
    await newcomer.page.goto(new URL(link).pathname);
    await newcomer.page.waitForURL(new RegExp(`/r/${treeId}`));

    // A link created after the removal admits them again.
    const newLink = await copyInviteLink(dialog);
    await member.page.goto(new URL(newLink).pathname);
    await member.page.waitForURL(new RegExp(`/r/${treeId}`));
    await expect(member.page.getByText(prompt).first()).toBeVisible();
  } finally {
    await Promise.all([owner.context.close(), member.context.close(), newcomer.context.close()]);
  }
});

test("a thread made public in the Share dialog opens for a guest, read-only", async ({
  browser,
}) => {
  const owner = await signedInContext(browser, "e2e-ui-public-owner");
  const guest = await browser.newContext();
  try {
    const prompt = "Can a guest read a public thread?";
    const detail = await completedThread(owner.page, prompt);
    const treeId = detail.tree.id;
    await owner.page.goto(`/r/${treeId}`);
    const dialog = await openShareDialog(owner.page);
    const publicChoice = dialog.getByRole("radio", { name: /Public/ });
    await publicChoice.click();
    await expect(publicChoice).toBeChecked();
    await expect
      .poll(
        async () =>
          (
            await query<{ tree: { visibility?: string } }>(owner.request, "research.getTree", {
              treeId,
            })
          ).tree.visibility,
      )
      .toBe("public");

    const page = await guest.newPage();
    await page.goto(`/r/${treeId}`);
    await expect(page.getByText(prompt).first()).toBeVisible();
    await expect(page.locator("[data-research-response-root]").first()).not.toBeEmpty();
    await expect(page.getByRole("textbox", { name: "Follow-up in this conversation" })).toHaveCount(
      0,
    );
  } finally {
    await Promise.all([owner.context.close(), guest.close()]);
  }
});

test("a stale note edit prompts to reload and keeps the text", async ({ browser }) => {
  const owner = await signedInContext(browser, "e2e-ui-stale-owner");
  try {
    const workspace = await mutation<{ id: string }>(owner.request, "workspaces.ensureDefault", {});
    const post = await mutation<Detail>(owner.request, "research.createPost", {
      body: "The note as first written",
      workspaceId: workspace.id,
      model: "gemini-flash",
    });
    const nodeId = post.nodes[0]!.id;
    await owner.page.goto(`/r/${post.tree.id}`);
    await owner.page
      .getByRole("region", { name: /^Note:/ })
      .getByText("The note as first written")
      .dblclick();
    const field = owner.page.getByRole("textbox", { name: "Note text" });
    await field.fill("My edit in the open editor");
    // Another editor saves first.
    await mutation(owner.request, "research.updatePost", {
      nodeId,
      text: "A version saved elsewhere",
      expectedText: "The note as first written",
    });
    await owner.page.getByRole("button", { name: /^Save/ }).click();
    const prompt = owner.page.getByRole("dialog", { name: "This note changed" });
    await expect(prompt).toBeVisible();
    await expect(prompt.getByRole("textbox", { name: "Your text" })).toHaveValue(
      "My edit in the open editor",
    );
    await prompt.getByRole("button", { name: "Reload latest version" }).click();
    await expect(prompt).toHaveCount(0);
    await expect(field).toHaveValue("My edit in the open editor");
    await owner.page.getByRole("button", { name: /^Save/ }).click();
    await expect
      .poll(
        async () =>
          (
            await query<{ nodes: { message?: { text: string } }[] }>(
              owner.request,
              "research.getTree",
              { treeId: post.tree.id },
            )
          ).nodes[0]?.message?.text,
      )
      .toBe("My edit in the open editor");
  } finally {
    await owner.context.close();
  }
});

test("invite and accept; the commenter asks and pays; the viewer cannot ask", async ({
  browser,
}) => {
  const owner = await signedInContext(browser, "e2e-share-owner");
  const commenter = await signedInContext(browser, "e2e-share-commenter");
  const viewer = await signedInContext(browser, "e2e-share-viewer");
  try {
    const detail = await completedThread(owner.page, "What does a shared thread look like?");
    const treeId = detail.tree.id;
    const rootId = detail.nodes[0]!.id;

    // Not readable before the invitation is accepted.
    expect(
      await refusal(commenter.request, "followups.ask", { headNodeId: rootId, prompt: "x" }),
    ).toBe("NOT_FOUND");
    const link = await mutation<{ token: string }>(owner.request, "invites.create", {
      treeId,
      role: "commenter",
    });
    const joined = await mutation<{ role: string }>(commenter.request, "invites.accept", {
      token: link.token,
    });
    expect(joined.role).toBe("commenter");
    const byLogin = await mutation<{ invite: { id: string } }>(owner.request, "invites.create", {
      treeId,
      role: "viewer",
      githubLogin: "e2e-share-viewer",
    });
    await mutation(viewer.request, "invites.accept", { inviteId: byLogin.invite.id });

    const before = await query<{ runs: number }>(commenter.request, "usage.summary", undefined);
    const asked = await mutation<{ kind: string; node?: { id: string; authorId?: string } }>(
      commenter.request,
      "followups.ask",
      { headNodeId: rootId, prompt: "And who pays for this follow-up?" },
    );
    expect(asked.kind).toBe("sent");
    expect(asked.node?.authorId).toBe(commenter.user.id);
    await expect
      .poll(
        async () =>
          (await query<{ runs: number }>(commenter.request, "usage.summary", undefined)).runs,
      )
      .toBe(before.runs + 1);

    expect(
      await refusal(viewer.request, "followups.ask", { headNodeId: rootId, prompt: "May I?" }),
    ).toBe("FORBIDDEN");
    const members = await query<{ login: string; role: string }[]>(
      viewer.request,
      "sharing.listMembers",
      { treeId },
    );
    expect(members.map((member) => [member.login, member.role])).toEqual([
      ["e2e-share-owner", "owner"],
      ["e2e-share-commenter", "commenter"],
      ["e2e-share-viewer", "viewer"],
    ]);
  } finally {
    await Promise.all([owner.context.close(), commenter.context.close(), viewer.context.close()]);
  }
});

test("a public thread opens for another account and for a guest", async ({ browser }) => {
  const owner = await signedInContext(browser, "e2e-public-owner");
  const other = await signedInContext(browser, "e2e-public-reader");
  const guest = await browser.newContext();
  try {
    const prompt = "Which threads are listed for guests?";
    const detail = await completedThread(owner.page, prompt);
    const treeId = detail.tree.id;
    expect(
      await refusal(other.request, "sharing.setVisibility", { treeId, visibility: "public" }),
    ).toBe("NOT_FOUND");
    await mutation(owner.request, "sharing.setVisibility", { treeId, visibility: "public" });

    const opened = await query<Detail>(other.request, "research.getTree", { treeId });
    expect(opened.tree.role).toBe("viewer");
    const guestPage = await guest.newPage();
    const catalog = await query<{ id: string }[]>(guestPage.request, "research.listTrees", {});
    expect(catalog.map((summary) => summary.id)).toContain(treeId);
    await guestPage.goto(`/r/${treeId}`);
    await expect(guestPage.getByText(prompt).first()).toBeVisible();
  } finally {
    await Promise.all([owner.context.close(), other.context.close(), guest.close()]);
  }
});

test("a member sees the owner's new question arrive live", async ({ browser }) => {
  const owner = await signedInContext(browser, "e2e-live-owner");
  const member = await signedInContext(browser, "e2e-live-member");
  try {
    const detail = await completedThread(owner.page, "Does a member see live updates?");
    const treeId = detail.tree.id;
    const link = await mutation<{ token: string }>(owner.request, "invites.create", {
      treeId,
      role: "viewer",
    });
    await mutation(member.request, "invites.accept", { token: link.token });
    await member.page.goto(`/r/${treeId}`);
    await expect(member.page.getByText("Does a member see live updates?").first()).toBeVisible();

    const followUp = "A follow-up the member did not reload for";
    await mutation(owner.request, "followups.ask", {
      headNodeId: detail.nodes[0]!.id,
      prompt: followUp,
    });
    await expect(member.page.getByText(followUp).first()).toBeVisible();
  } finally {
    await Promise.all([owner.context.close(), member.context.close()]);
  }
});

test("a stale note edit is refused", async ({ browser }) => {
  const owner = await signedInContext(browser, "e2e-stale-owner");
  try {
    const workspace = await mutation<{ id: string }>(owner.request, "workspaces.ensureDefault", {});
    const post = await mutation<Detail>(owner.request, "research.createPost", {
      body: "The first version of a note",
      workspaceId: workspace.id,
      model: "gemini-flash",
    });
    const nodeId = post.nodes[0]!.id;
    await mutation(owner.request, "research.updatePost", {
      nodeId,
      text: "The second version",
      expectedText: "The first version of a note",
    });
    expect(
      await refusal(owner.request, "research.updatePost", {
        nodeId,
        text: "A third version from a stale editor",
        expectedText: "The first version of a note",
      }),
    ).toBe("CONFLICT");
  } finally {
    await owner.context.close();
  }
});
