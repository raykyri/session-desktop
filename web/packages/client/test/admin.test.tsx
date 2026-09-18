// The administrator view (07 §3). What is asserted here is the one number on
// the page the server also computes: the day's token spend, which has to match
// what `admissionCheck` charges an account against its limit.

import { cleanup, screen } from "@testing-library/react";
import test from "ava";

import { renderApp, resetDocumentRoot, testUser } from "./helpers.js";

test.afterEach.always(() => {
  cleanup();
  resetDocumentRoot();
});

const adminUser = (usage: Record<string, number>) => ({
  ...testUser({ id: "u2", login: "someone", isAdmin: false }),
  usage: {
    day: 1_700_000_000_000,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedTokens: 0,
    costEstimateMicros: 0,
    runs: 0,
    ...usage,
  },
  limits: { dailyTokens: null, dailyRuns: null },
  workspaceCount: 1,
});

test.serial("the token column counts what the limit counts, not thinking twice", async (t) => {
  await renderApp("/admin", {
    user: testUser({ isAdmin: true }),
    responses: {
      "admin.listUsers": [
        adminUser({ inputTokens: 1_000, outputTokens: 500, reasoningTokens: 400 }),
      ],
    },
  });

  const row = await screen.findByText("someone");
  const cells = [...(row.closest("tr")?.querySelectorAll("td") ?? [])].map(
    (cell) => cell.textContent,
  );
  // `reasoningTokens` is a breakdown of `outputTokens`, so the sum is 1,500 —
  // the same number `db/repos/usage.ts:admissionCheck` spends.
  t.is(cells[3], "1.5k");
});

test.serial("the model access column names the gated model only where it applies", async (t) => {
  await renderApp("/admin", {
    user: testUser({ isAdmin: true }),
    responses: {
      "admin.listUsers": [
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
  t.true(admin.includes("Claude Fable 5.1"), "which is exactly what the admin flag buys");
});
