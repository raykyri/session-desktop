// The shell is public (07 §2). Guests read the catalog; `/bookmarks`,
// `/highlights`, and `/admin` still redirect to `/login`. Account-scoped boot
// queries (`settings.get`, live events) stay behind a session.

import { cleanup, fireEvent, screen } from "@testing-library/react";
import test from "ava";

import { renderApp, resetDocumentRoot, testUser } from "./helpers.js";

// `always`, so a failed assertion does not leave its tree mounted for the
// next test to trip over.
test.afterEach.always(() => {
  cleanup();
  resetDocumentRoot();
});

test.serial("a signed-out visit to a shell route renders the public shell", async (t) => {
  await renderApp("/r/t1", { user: null });

  t.truthy(screen.getByRole("navigation", { name: "Sections" }));
  t.truthy(screen.getByRole("button", { name: "Sign in" }));
  t.is(screen.queryByRole("button", { name: /Continue with GitHub/ }), null);
});

test.serial("the sign-in page displays server authentication error messages", async (t) => {
  await renderApp("/login?error=invite_required", { user: null });

  t.is(
    screen.getByRole("alert").textContent,
    "An invite code is required to create an account. Please use the invitation link you received.",
  );
});

test.serial("unrecognized authentication errors display a default error message", async (t) => {
  await renderApp("/login?error=teapot", { user: null });

  t.is(screen.getByRole("alert").textContent, "Sign-in did not complete. Try again.");
});

test.serial("a signed-in visit renders the shell and the account row", async (t) => {
  await renderApp("/", { user: testUser({ login: "raymond" }) });

  t.truthy(screen.getByRole("navigation", { name: "Sections" }));
  t.truthy(screen.getByRole("button", { name: "raymond" }));
});

test.serial("a guest account menu offers GitHub sign-in", async (t) => {
  await renderApp("/", { user: null });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  t.truthy(await screen.findByRole("menuitem", { name: /Log in with GitHub/ }));
});

test.serial("a guest visit does not fetch account-scoped boot queries", async (t) => {
  const { trpc } = await renderApp("/", { user: null });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const paths = trpc.calls.map((call) => call.path);
  t.false(paths.includes("settings.get"));
  t.false(paths.includes("research.listActivity"));
  t.false(paths.includes("workspaces.ensureDefault"));
  t.true(paths.includes("system.runtimeConfig"));
  t.true(paths.includes("workspaces.list"));
});

test.serial("the boot loader warms the seven queries the shell renders from", async (t) => {
  const { trpc } = await renderApp("/", {
    responses: {
      "settings.get": {
        colorTheme: "green-blob",
        appearance: "dark",
        bodyFontId: "dm-sans",
        textSize: 14,
        showToolCalls: true,
        showAssistantTimestamps: false,
        showNotifications: true,
        defaultModel: "gemini-flash",
        researchLaunchInstruction: null,
        defaultWorkspaceId: "w1",
      },
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  const paths = new Set(trpc.calls.map((call) => call.path));
  for (const path of [
    "settings.get",
    "system.runtimeConfig",
    "workspaces.list",
    "research.listTrees",
    "folders.get",
    // Not rendered anywhere: it is the cache `cachedNode` reads, and an empty
    // one makes every node update for an unopened thread invalidate the
    // sidebar instead of patching it.
    "research.listActivity",
  ]) {
    t.true(paths.has(path), `${path} was warmed`);
  }
});

test.serial("authenticated visits to /login redirect to the requested target URL", async (t) => {
  // The guard puts the path it refused on `?redirect=`; coming back with a
  // session — after signing in, or with Back — continues there rather than
  // showing a sign-in button to somebody who is signed in.
  await renderApp("/login?redirect=%2Fsettings", { user: testUser() });

  t.truthy(screen.getByRole("heading", { name: "Settings" }));
  t.is(screen.queryByRole("button", { name: /Continue with GitHub/ }), null);
});

test.serial("a redirect that leaves this origin is not followed", async (t) => {
  await renderApp("/login?redirect=%2F%2Fevil.example%2Fsteal", { user: testUser() });

  t.truthy(screen.getByRole("navigation", { name: "Sections" }), "the shell rendered");
  t.truthy(screen.getByRole("heading", { name: "All Users" }), "at the root, not at the target");
});

test.serial("development kitchen sink routes are absent from production builds", async (t) => {
  // `import.meta.env` is absent outside Vite, so this suite runs the route
  // tree exactly as a production bundle carries it: no `/dev/*` route.
  await renderApp("/dev/ui", { user: null });

  t.truthy(screen.getByRole("navigation", { name: "Sections" }), "the public shell still renders");
  t.is(screen.queryByRole("heading", { name: /Cool · Dark/ }), null, "and no kitchen sink");
});
