// Shared setup for the repository tests: a temp file database per test file,
// because WAL, foreign keys, and the partial unique index are file-level
// behavior and an in-memory database does not exercise all of it
// (`docs/12-testing-linting-ci.md` §3.2). Tests that only need rows use
// `openDatabase(":memory:")` directly.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Turn } from "@session/shared";
import type { ExecutionContext } from "ava";

import type { SessionDatabase } from "../src/index.js";
import { closeDatabase, openDatabase, users, workspaces } from "../src/index.js";

export interface Fixture {
  db: SessionDatabase;
  directory: string;
  userId: string;
  workspaceId: string;
}

let githubIdCounter = 1000;

/**
 * A database on disk with one account and one workspace.
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
  githubIdCounter += 1;
  const { user } = users.upsertFromGitHub(db, {
    githubId: githubIdCounter,
    login: `user${githubIdCounter}`,
    name: "Test User",
  });
  const workspace = workspaces.create(db, user.id, "Research");
  return { db, directory, userId: user.id, workspaceId: workspace.id };
}

/** A second account on the same database, for the scoping tests. */
export function addUser(
  db: SessionDatabase,
  login: string,
): { userId: string; workspaceId: string } {
  githubIdCounter += 1;
  const { user } = users.upsertFromGitHub(db, { githubId: githubIdCounter, login });
  const workspace = workspaces.create(db, user.id, "Research");
  return { userId: user.id, workspaceId: workspace.id };
}

/** A minimal assistant turn, the shape the snapshot commit requires. */
export function answerTurn(nodeId: string, text: string, id = `${nodeId}-turn`): Turn {
  return {
    id,
    agentId: nodeId,
    role: "assistant",
    blocks: [{ type: "text", text }],
    sourceIndex: 0,
  };
}

/** A highlight anchor over `exact` inside an answer at `revision`. */
export function anchorFor(
  revision: string,
  exact: string,
  start = 0,
): {
  version: 1;
  projection: "answer-v1";
  responseRevision: string;
  start: number;
  end: number;
  exact: string;
  prefix: string;
  suffix: string;
} {
  return {
    version: 1,
    projection: "answer-v1",
    responseRevision: revision,
    start,
    end: start + exact.length,
    exact,
    prefix: "",
    suffix: "",
  };
}
