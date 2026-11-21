// The account screens (02 W7.1-W7.3): the auth dialog's steps on a fake
// `auth.checkInvite`, the profile step, "Invite required" and the Invites
// page, plus rendering of untrusted account text (04 Z5).

import { UNUSABLE_INVITE_MESSAGE, parseInviteCode } from "@session/shared";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import test from "ava";

import { treeRows } from "../src/features/auth/InvitesPage.js";
import { openAuthDialog } from "../src/features/auth/authDialog.js";
import { clearToast, currentToast } from "../src/features/shell/Toast.js";
import { clearPendingInvite } from "../src/lib/pendingInvite.js";

import { renderApp, resetDocumentRoot, testUser, waitUntil, waitingTestUser } from "./helpers.js";

const INES = { name: "Ines Vidal", handle: "ines.v" };

test.afterEach.always(() => {
  cleanup();
  resetDocumentRoot();
  clearPendingInvite();
  clearToast();
});

const dialog = () => screen.getByRole("dialog", { name: "Sign in to Session" });
/** The text of every alert on the page (the toast host keeps empty alert
 * regions mounted). */
const alertTexts = () => screen.queryAllByRole("alert").map((node) => node.textContent ?? "");

/** A checkInvite that answers open for one code and unusable otherwise. */
const checkFor = (open: string) => (input: unknown) =>
  (input as { code: string }).code === open
    ? { status: "open", inviter: INES }
    : { status: "unusable" };

function typeCode(value: string) {
  const field = within(dialog()).getByRole("textbox", { name: "Invite code" });
  fireEvent.change(field, { target: { value } });
  fireEvent.click(within(dialog()).getByRole("button", { name: "Continue" }));
}

test("the code field reads a code, a fragment link and a pasted path", (t) => {
  t.is(parseInviteCode("SESS-9TQ2-X8"), "SESS-9TQ2-X8");
  t.is(parseInviteCode("https://session.dev/i#sess-9tq2-x8"), "SESS-9TQ2-X8");
  t.is(parseInviteCode("https://session.dev/i/SESS-9TQ2-X8/"), "SESS-9TQ2-X8");
  t.is(parseInviteCode(" sess 9tq2 x8 "), "SESS-9TQ2-X8");
  t.is(parseInviteCode("SESS-0000-00"), null, "0 is not in the alphabet");
  t.is(parseInviteCode(""), null);
});

test.serial("every X button has its GitHub twin", async (t) => {
  await renderApp("/", { user: null, responses: { "auth.checkInvite": checkFor("SESS-9TQ2-X8") } });
  openAuthDialog({ step: "landing" });
  for (const label of ["Sign in with X", "Sign in with GitHub"]) {
    t.truthy(await within(await screen.findByRole("dialog")).findByRole("button", { name: label }));
  }
  fireEvent.click(within(dialog()).getByRole("button", { name: "I have an invite code" }));
  typeCode("SESS-9TQ2-X8");
  t.truthy(await within(dialog()).findByText("Invite from Ines Vidal"));
  t.truthy(within(dialog()).getByRole("button", { name: "Sign up with X" }));
  t.truthy(within(dialog()).getByRole("button", { name: "Sign up with GitHub" }));
  openAuthDialog({ step: "landing", link: { code: "SESS-9TQ2-X8", state: "open", inviter: INES } });
  t.truthy(await within(dialog()).findByRole("button", { name: "Continue with X" }));
  t.truthy(within(dialog()).getByRole("button", { name: "Continue with GitHub" }));
  openAuthDialog({
    step: "landing",
    link: { code: "SESS-AAAA-AA", state: "unusable", inviter: null },
  });
  t.truthy(await within(dialog()).findByText("This invite link no longer works"));
  t.truthy(within(dialog()).getByRole("button", { name: "Sign in with X" }));
  t.truthy(within(dialog()).getByRole("button", { name: "Sign in with GitHub" }));
});

test.serial(
  "the code step: empty, then one message for used, revoked and unknown codes",
  async (t) => {
    await renderApp("/", {
      user: null,
      responses: { "auth.checkInvite": checkFor("SESS-9TQ2-X8") },
    });
    openAuthDialog({ step: "code" });
    await screen.findByRole("heading", { name: "Join with invite?" });
    typeCode("");
    t.is(
      (await within(dialog()).findByRole("alert")).textContent,
      "Enter the code from your invite.",
    );
    const messages: string[] = [];
    for (const code of ["SESS-4KQ7-M2", "SESS-77LD-QA", "SESS-ZZZZ-ZZ"]) {
      typeCode(code);
      await waitUntil(
        t,
        () => within(dialog()).queryByRole("alert")?.textContent === UNUSABLE_INVITE_MESSAGE,
        code,
      );
      messages.push(within(dialog()).getByRole("alert").textContent ?? "");
    }
    t.is(new Set(messages).size, 1);
    t.is(
      messages[0],
      "This invite code doesn't work. Ask the person who invited you for a new one.",
    );
  },
);

test.serial("Continue to GitHub posts the code to the start route, not a URL", async (t) => {
  const posted: { url: string; body: string }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((url: string, init: RequestInit) => {
    posted.push({ url, body: typeof init.body === "string" ? init.body : "" });
    return Promise.resolve(new Response(JSON.stringify({ error: "nope" }), { status: 503 }));
  }) as typeof fetch;
  t.teardown(() => {
    globalThis.fetch = realFetch;
  });
  await renderApp("/c/ml", { user: null });
  openAuthDialog({ step: "landing", link: { code: "SESS-9TQ2-X8", state: "open", inviter: INES } });
  await screen.findByRole("dialog");
  fireEvent.click(await within(dialog()).findByRole("button", { name: "Continue with GitHub" }));
  t.truthy(
    await within(dialog()).findByText(
      /Session uses your name, handle and profile picture from GitHub/,
    ),
  );
  t.truthy(within(dialog()).getByText("Use the same account each time you sign in."));
  fireEvent.click(within(dialog()).getByRole("button", { name: "Continue to GitHub" }));
  t.truthy(await within(dialog()).findByRole("alert"));
  t.is(posted[0]?.url, "/auth/github/start");
  t.deepEqual(JSON.parse(posted[0]?.body ?? "{}"), { code: "SESS-9TQ2-X8", returnTo: "/c/ml" });
});

test.serial("a waiting account holding an invite gets the profile step", async (t) => {
  const user = {
    ...waitingTestUser({ login: "Rhea-OK", name: "Rhea Okafor" }),
    pendingInvite: INES,
  };
  const app = await renderApp("/", {
    user,
    responses: {
      "account.checkHandle": (input: unknown) => ({
        valid: true,
        available: (input as { handle: string }).handle !== "ines.v",
      }),
      "account.create": (input: unknown) => {
        const { handle } = input as { handle: string };
        if (handle === "taken.one") {
          throw Object.assign(new Error("@taken.one is taken. Try another."), {
            data: { code: "CONFLICT" },
          });
        }
        return { me: { ...testUser({ login: "Rhea-OK" }), handle }, inviter: INES };
      },
    },
  });
  const heading = await screen.findByRole("heading", { name: "Create your account" });
  t.truthy(heading);
  t.truthy(within(dialog()).getByText("Signed in with GitHub as @Rhea-OK"));
  t.truthy(within(dialog()).getByText("Invited by Ines Vidal"));
  const name = within(dialog()).getByRole("textbox", { name: "Name" });
  const handle = within(dialog()).getByRole("textbox", { name: /Handle on Session/ });
  t.is((name as HTMLInputElement).value, "Rhea Okafor");
  t.is(
    (handle as HTMLInputElement).value,
    "rhea-ok".replace("-", ""),
    "a suggestion from the login",
  );
  const submit = () =>
    fireEvent.click(within(dialog()).getByRole("button", { name: "Create account" }));
  fireEvent.change(name, { target: { value: "  " } });
  submit();
  t.is((await within(dialog()).findByRole("alert")).textContent, "Enter a name.");
  fireEvent.change(name, { target: { value: "Rhea" } });
  fireEvent.change(handle, { target: { value: "No" } });
  submit();
  t.is(
    within(dialog()).getByRole("alert").textContent,
    "Handles use 3 to 20 lowercase letters, numbers, dots or underscores.",
  );
  fireEvent.change(handle, { target: { value: "taken.one" } });
  submit();
  await waitUntil(
    t,
    () =>
      within(dialog()).queryByRole("alert")?.textContent === "@taken.one is taken. Try another.",
    "taken",
  );
  fireEvent.change(handle, { target: { value: "rhea" } });
  submit();
  await waitUntil(t, () => currentToast() === "Account created. Ines Vidal invited you.", "toast");
  t.deepEqual(app.trpc.calls.filter((call) => call.path === "account.create").at(-1)?.input, {
    name: "Rhea",
    handle: "rhea",
  });
});

test.serial("a new waiting account sees No Session account, then Invite required", async (t) => {
  const app = await renderApp("/welcome?new=1", {
    user: waitingTestUser({ login: "rheaok" }),
    responses: {
      "accountInvites.redeem": (input: unknown) =>
        (input as { code: string }).code === "SESS-9TQ2-X8"
          ? { status: "open", inviter: INES }
          : { status: "unusable" },
    },
  });
  t.truthy(await screen.findByRole("heading", { name: "No Session account for @rheaok" }));
  await waitUntil(t, () => !app.router.state.location.href.includes("new="), "marker dropped");
  fireEvent.click(within(dialog()).getByRole("button", { name: "Continue without one" }));
  await waitUntil(t, () => app.router.state.location.pathname === "/", "reads Home");

  await app.router.navigate({ to: "/welcome" });
  t.truthy(await screen.findByRole("heading", { name: "Invite required" }));
  t.truthy(
    screen.getByText(
      "You're signed in as @rheaok, but Session is invite-only. Enter a code or link from a member to start asking and posting.",
    ),
  );
  const field = screen.getByRole("textbox", { name: "Invite code" });
  fireEvent.click(screen.getByRole("button", { name: "Use code" }));
  await waitUntil(t, () => alertTexts().includes("Enter the code from your invite."), "empty code");
  fireEvent.change(field, { target: { value: "SESS-4KQ7-M2" } });
  fireEvent.click(screen.getByRole("button", { name: "Use code" }));
  await waitUntil(t, () => alertTexts().includes(UNUSABLE_INVITE_MESSAGE), "unusable");
  fireEvent.change(field, { target: { value: "https://session.dev/i#sess-9tq2-x8" } });
  fireEvent.click(screen.getByRole("button", { name: "Use code" }));
  t.truthy(await screen.findByRole("heading", { name: "Create your account" }));
  t.deepEqual(
    app.trpc.calls.filter((call) => call.path === "accountInvites.redeem").at(-1)?.input,
    { code: "SESS-9TQ2-X8" },
  );
});

/** A 12-account tree in the mockup's shape: sol at the root. */
const TREE = [
  ["sol", null, 1],
  ["ines.v", "sol", 2],
  ["jun.park", "sol", 3],
  ["priya.n", "ines.v", 4],
  ["hal_b", "jun.park", 5],
  ["dmitri_k", "hal_b", 6],
  ["lettie", "sol", 7],
  ["rheaok", "ines.v", 8],
  ["amara", "lettie", 9],
  ["bo.chen", "priya.n", 10],
  ["kofi", "jun.park", 11],
  ["mina", "ines.v", 12],
] as const;

interface FixtureNode {
  id: string;
  handle: string | null;
  displayName: string | null;
  avatar: null;
  invitedBy: string | null;
  joinedAt: number;
  staff: "admin" | null;
}

const treeNodes = (): FixtureNode[] =>
  TREE.map(([handle, inviter, at]) => ({
    id: handle,
    handle,
    displayName: handle,
    avatar: null,
    invitedBy: inviter,
    joinedAt: at,
    staff: handle === "sol" ? "admin" : null,
  }));

test("the tree is depth-first from the roots with children by join date", (t) => {
  t.deepEqual(
    treeRows(treeNodes()).map((row) => `${"-".repeat(row.depth)}${row.node.handle ?? ""}`),
    [
      "sol",
      "-ines.v",
      "--priya.n",
      "---bo.chen",
      "--rheaok",
      "--mina",
      "-jun.park",
      "--hal_b",
      "---dmitri_k",
      "--kofi",
      "-lettie",
      "--amara",
    ],
  );
});

const invitesView = (open: number) => ({
  links: Array.from({ length: open }, (_, index) => ({
    id: `L${index}`,
    state: "open",
    createdAt: index,
    usedAt: null,
    code: `SESS-AAA${index + 2}-BB`,
    link: `http://localhost/i#SESS-AAA${index + 2}-BB`,
    usedBy: null,
  })),
  invited: [
    { handle: "priya.n", displayName: "Priya", avatarUrl: null, joinedAt: Date.UTC(2026, 10, 14) },
  ],
  openCount: open,
  openLimit: 3,
});

test.serial("Invites: the tree, the open links, and no create button at 3 open", async (t) => {
  const nodes = treeNodes();
  nodes[1] = { ...nodes[1]!, displayName: '<img src=x onerror="alert(1)">' };
  await renderApp("/invites", {
    user: testUser({ id: "ines.v", login: "ines.v" }),
    responses: { "members.tree": nodes, "accountInvites.list": invitesView(3) },
  });
  const tree = await screen.findByRole("list", { name: "Invite tree" });
  const rows = within(tree).getAllByRole("listitem");
  t.is(rows.length, 12);
  t.is(rows[0]?.textContent, "SOsol · Adminsol");
  t.true(rows[1]?.classList.contains("me"), rows[1]?.outerHTML);
  // An untrusted display name is text, never markup (04 Z5).
  t.truthy(within(tree).getByText('<img src=x onerror="alert(1)">'));
  t.is(document.querySelector("img"), null);
  t.truthy(screen.getByText("0 of 3 left"));
  t.is(screen.queryByRole("button", { name: /Create/ }), null);
  t.truthy(screen.getByText("You have 3 open invites. One frees when it is used or revoked."));
  t.is(screen.getAllByRole("button", { name: "Revoke this link" }).length, 3);
  t.truthy(screen.getByText("Joined Nov 14"));
});

test.serial("Invites: create, copy and revoke toast", async (t) => {
  const copied: string[] = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: (text: string) => Promise.resolve(void copied.push(text)) },
  });
  t.teardown(() => {
    Reflect.deleteProperty(navigator, "clipboard");
  });
  const app = await renderApp("/invites", {
    user: testUser({ login: "ines.v" }),
    responses: {
      "members.tree": treeNodes(),
      "accountInvites.list": invitesView(1),
      "accountInvites.create": {
        id: "N",
        code: "SESS-9TQ2-X8",
        link: "http://localhost/i#SESS-9TQ2-X8",
      },
      "accountInvites.revoke": { ok: true },
    },
  });
  fireEvent.click(await screen.findByRole("button", { name: "Create a new link" }));
  await waitUntil(
    t,
    () => currentToast() === "Invite SESS-9TQ2-X8 created. Send the link to one person.",
    "created",
  );
  fireEvent.click(screen.getByRole("button", { name: "Revoke this link" }));
  await waitUntil(t, () => currentToast() === "Invite revoked.", "revoked");
  t.deepEqual(app.trpc.calls.find((call) => call.path === "accountInvites.revoke")?.input, {
    id: "L0",
  });
  fireEvent.click(screen.getByRole("button", { name: "Copy" }));
  await waitUntil(t, () => currentToast() === "Link copied.", "copied");
  t.deepEqual(copied, ["http://localhost/i#SESS-AAA2-BB"]);
});

test.serial("a waiting account is sent from Invites to Invite required", async (t) => {
  const app = await renderApp("/invites", { user: waitingTestUser() });
  await waitUntil(t, () => app.router.state.location.pathname === "/welcome", "to /welcome");
});
