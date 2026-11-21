// Shared setup for the repository tests: a temp file database per test file,
// because WAL and foreign keys are file-level behavior and an in-memory
// database does not exercise all of it (`docs/12-testing-linting-ci.md`
// §3.2). Tests that only need rows use `openDatabase(":memory:")` directly.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { User } from "@session/shared";
import type { ExecutionContext } from "ava";

import type { SessionDatabase } from "../src/index.js";
import { closeDatabase, openDatabase, users } from "../src/index.js";

export interface Fixture {
  db: SessionDatabase;
  directory: string;
  userId: string;
}

let githubIdCounter = 1000;

/**
 * A database on disk with one account.
 *
 * Cleanup is registered with `t.teardown` rather than returned as a `close()`
 * the test body has to remember to call: a failing assertion aborts the body,
 * and a temp directory per failed test would survive the run.
 */
export function createFixture(t: ExecutionContext): Fixture {
  const directory = mkdtempSync(join(tmpdir(), "session-db-"));
  const db = openDatabase(join(directory, "session.db"));
  t.teardown(() => {
    closeDatabase(db);
    rmSync(directory, { recursive: true, force: true });
  });
  const user = addActiveUser(db, `user${githubIdCounter + 1}`);
  return { db, directory, userId: user.id };
}

/** An active account with `handle`, made directly (no invite). */
export function addActiveUser(
  db: SessionDatabase,
  handle: string,
  options: { invitedBy?: string | null } = {},
): User {
  githubIdCounter += 1;
  return users.createActive(
    db,
    {
      provider: "github",
      providerUserId: String(githubIdCounter),
      login: handle,
      name: "Test User",
    },
    { handle, displayName: handle, invitedBy: options.invitedBy ?? null },
  );
}

/** A waiting account for a new identity. */
export function addWaitingUser(
  db: SessionDatabase,
  options: { provider?: "github" | "x"; providerUserId?: string; pendingInviteId?: string } = {},
): User {
  githubIdCounter += 1;
  return users.createWaiting(
    db,
    {
      provider: options.provider ?? "github",
      providerUserId: options.providerUserId ?? String(githubIdCounter),
      login: `waiting${githubIdCounter}`,
      name: "Waiting User",
    },
    { pendingInviteId: options.pendingInviteId ?? null },
  ).user;
}
