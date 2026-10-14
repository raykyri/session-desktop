// Sharing a thread between two accounts and a guest, each in its own browser
// context (`02-domain-model-and-database.md` §5.16). The sharing UI comes
// later; these drive the server through its tRPC endpoint with each
// context's own session cookie, and check the existing thread page where it
// already shows the result.

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
