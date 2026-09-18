// The guard (07 §2): no session means `/login`, whatever was asked for, and a
// session means the shell. The redirect is what keeps a signed-out tab from
// firing every boot query at a server that will refuse them.

import { cleanup, screen } from "@testing-library/react";
import test from "ava";

import { renderApp, resetDocumentRoot, testUser } from "./helpers.js";

// `always`, so a failed assertion does not leave its tree mounted for the
// next test to trip over.
test.afterEach.always(() => {
  cleanup();
  resetDocumentRoot();
});

test.serial("a signed-out visit to a shell route lands on sign-in", async (t) => {
  await renderApp("/r/t1", { user: null });

  t.truthy(screen.getByRole("button", { name: /Continue with GitHub/ }));
  t.is(screen.queryByRole("navigation", { name: "Sections" }), null, "no shell was rendered");
});

test.serial("the sign-in page reports the server's refusal", async (t) => {
  await renderApp("/login?error=invite_required", { user: null });

  t.is(
    screen.getByRole("alert").textContent,
    "Signing up needs an invite code. Use the link you were sent.",
  );
});

test.serial("an unrecognized refusal still says something", async (t) => {
  await renderApp("/login?error=teapot", { user: null });

  t.is(screen.getByRole("alert").textContent, "Sign-in did not complete. Try again.");
});

test.serial("a signed-in visit renders the shell and the account row", async (t) => {
  await renderApp("/", { user: testUser({ login: "raymond" }) });

  t.truthy(screen.getByRole("navigation", { name: "Sections" }));
  t.truthy(screen.getByRole("button", { name: "raymond" }));
});

test.serial("the boot loader warms the six queries the shell renders from", async (t) => {
  const { trpc } = await renderApp("/", {
    responses: {
      "settings.get": {
        colorTheme: "green-blob",
        appearance: "dark",
        bodyFontId: "dm-sans",
        textSize: 14,
        showShortcutHints: true,
        reduceMotion: false,
        showToolCalls: true,
        showAssistantTimestamps: false,
        showNotifications: true,
        requireCmdEnterToSend: false,
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
    "encyclopedia.listPages",
  ]) {
    t.true(paths.has(path), `${path} was warmed`);
  }
});

test.serial("a signed-in visit to sign-in goes on to what it asked for", async (t) => {
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
  t.truthy(screen.getByRole("heading", { name: "Home" }), "at the root, not at the target");
});

test.serial("the kitchen sink is not a way around the guard in a build", async (t) => {
  // `import.meta.env` is absent outside Vite, so this suite runs the route
  // tree exactly as a production bundle carries it: no `/dev/*` route, and the
  // guard's exemption off with it (07 §3).
  await renderApp("/dev/ui", { user: null });

  t.is(screen.queryByRole("navigation", { name: "Sections" }), null, "no shell was rendered");
  t.is(screen.queryByRole("heading", { name: /Cool · Dark/ }), null, "and no kitchen sink");
});
