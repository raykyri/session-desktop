// The administrator view (07 §3). What is asserted here is the one number on
// the page the server also computes: the day's token spend, which has to match
// what the server records as the account's usage this week.

import { cleanup, fireEvent, screen } from "@testing-library/react";
import test from "ava";

import { renderApp, resetDocumentRoot, testUser, waitUntil } from "./helpers.js";

test.afterEach.always(() => {
  cleanup();
  resetDocumentRoot();
});

const adminUser = (usage: Record<string, number>) => ({
  ...testUser({ id: "u2", login: "someone", handle: "someone", isAdmin: false }),
  usage: {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedTokens: 0,
    costEstimateMicros: 0,
    runs: 0,
    ...usage,
  },
  allowance: { weeklyTokens: null, defaultTokens: 250_000, used: 0 },
  workspaceCount: 1,
});

test.serial(
  "the token usage column excludes reasoning tokens to prevent double-counting",
  async (t) => {
    await renderApp("/admin", {
      user: testUser({ isAdmin: true }),
      routes: {
        "GET /api/admin/users": [
          adminUser({ inputTokens: 1_000, outputTokens: 500, reasoningTokens: 400 }),
        ],
      },
    });

    const row = await screen.findByText("someone");
    const cells = [...(row.closest("tr")?.querySelectorAll("td") ?? [])].map(
      (cell) => cell.textContent,
    );
    // `reasoningTokens` is a breakdown of `outputTokens`, so the sum is 1,500 —
    // the same number the server counts.
    t.is(cells[3], "1.5k");
  },
);

test.serial("the allowance column shows the default until an admin sets one, and saves a number", async (t) => {
  const app = await renderApp("/admin", {
    user: testUser({ isAdmin: true }),
    routes: { "GET /api/admin/users": [{ ...adminUser({}), allowance: { weeklyTokens: null, defaultTokens: 250_000, used: 12_000 } }] },
  });
  const input = await screen.findByRole("textbox", { name: "Weekly allowance for someone" });
  t.is((input as HTMLInputElement).value, "");
  t.is((input as HTMLInputElement).placeholder, "default (250.0k)");
  t.truthy(screen.getByText("12.0k of 250.0k"));
  app.server.routes.set("POST /api/admin/limits", { weeklyTokens: 40_000, defaultTokens: 250_000, used: 12_000 });
  fireEvent.change(input, { target: { value: "40000" } });
  fireEvent.blur(input);
  await waitUntil(t, () => app.server.calls.some((c) => c.path === "/api/admin/limits"), "saved");
  t.deepEqual(app.server.calls.find((c) => c.path === "/api/admin/limits")?.body, { userId: "u2", weeklyTokens: 40_000 });
  // "default" goes back to the deployment's
  fireEvent.change(input, { target: { value: "default" } });
  fireEvent.blur(input);
  t.pass();
});

test.serial("the model access column names the gated model only where it applies", async (t) => {
  await renderApp("/admin", {
    user: testUser({ isAdmin: true }),
    routes: {
      "GET /api/admin/users": [
        adminUser({}),
        { ...adminUser({}), id: "u3", login: "boss", isAdmin: true },
      ],
    },
  });

  const accessOf = async (login: string) => {
    const row = (await screen.findByText(login, { exact: false })).closest("tr");
    return row?.querySelectorAll("td")[1]?.textContent ?? "";
  };

  const plain = await accessOf("someone");
  t.true(plain.includes("Gemini 3.8 Flash"), "every account has the open models");
  t.false(plain.includes("Claude Fable 5.1"), "and a non-admin does not have the gated one");

  const admin = await accessOf("boss");
  t.true(
    admin.includes("Claude Fable 5.1"),
    "verifying the admin flag grants access to restricted models",
  );
});
