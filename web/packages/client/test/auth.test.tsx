// The guard (07 §2): no session means `/login`, whatever was asked for, and a
// session means the shell. The redirect is what keeps a signed-out tab from
// firing every boot query at a server that will refuse them.

import { cleanup, screen } from "@testing-library/react";
import test from "ava";

import { renderApp, resetDocumentRoot, testUser } from "./helpers.js";

test.afterEach(() => {
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
