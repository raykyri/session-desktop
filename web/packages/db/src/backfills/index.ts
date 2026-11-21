// Versioned data migrations that SQL cannot express
// (`docs/02-domain-model-and-database.md` §4). `openDatabase()` runs these
// after `migrate()`, in declaration order, each inside its own transaction,
// and records the ones that ran in `backfills`.

import { createHash } from "node:crypto";

import { sql } from "drizzle-orm";

import type { SessionDatabase } from "../connection.js";
import { newId } from "../ids.js";
import { backfills } from "../schema/backfills.js";
import { now } from "../time.js";

import { banUserLogs } from "./records.js";

export interface Backfill {
  /** Stable identifier, recorded in `backfills`. Never reused or renamed. */
  id: string;
  /** What the step does, for the operator reading a boot log. */
  description: string;
  run: (db: SessionDatabase) => void;
}

interface LegacyInviteRow {
  code: string;
  created_by: string | null;
  created_at: number;
  used_by: string | null;
  used_at: number | null;
}

/**
 * `0004_accounts.sql` renames the old `invites` table, which keyed rows on
 * the plain code, to `invites_legacy`. This moves its rows into the new
 * `invites` with the SHA-256 of the code in place of the code and drops the
 * old table, so no column holds a plain code afterwards (04 §3.1). Old codes
 * are not in the `SESS-XXXX-XX` form, so they hash to values no typed code
 * produces: they stay in the history but can no longer be redeemed.
 */
const hashAccountInvites: Backfill = {
  id: "0004-hash-account-invites",
  description: "hash the plain account invite codes of invites_legacy into invites",
  run: (db) => {
    const legacy = db.all<{ name: string }>(
      sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'invites_legacy'`,
    );
    if (legacy.length === 0) return;
    const rows = db.all<LegacyInviteRow>(
      sql`SELECT code, created_by, created_at, used_by, used_at FROM invites_legacy`,
    );
    for (const row of rows) {
      const codeHash = createHash("sha256").update(row.code, "utf8").digest("hex");
      db.run(
        sql`INSERT INTO invites (id, code_hash, code_enc, created_by, created_at, used_by, used_at, revoked_at)
            VALUES (${newId()}, ${codeHash}, NULL, ${row.created_by}, ${row.created_at},
                    ${row.used_by}, ${row.used_at}, NULL)`,
      );
    }
    db.run(sql`DROP TABLE invites_legacy`);
  },
};

/** In order; each runs once per database. */
export const BACKFILLS: readonly Backfill[] = [hashAccountInvites, banUserLogs];

/** Applies every backfill supported by this build that the database has not recorded.
 * Returns the ids applied, so boot can log them. */
export function runBackfills(
  db: SessionDatabase,
  steps: readonly Backfill[] = BACKFILLS,
): string[] {
  if (steps.length === 0) {
    return [];
  }
  const applied = new Set(
    db
      .select({ id: backfills.id })
      .from(backfills)
      .all()
      .map((row) => row.id),
  );
  const ran: string[] = [];
  for (const step of steps) {
    if (applied.has(step.id)) {
      continue;
    }
    db.transaction((tx) => {
      step.run(tx as unknown as SessionDatabase);
      tx.insert(backfills).values({ id: step.id, appliedAt: now() }).run();
    });
    ran.push(step.id);
  }
  return ran;
}

/** Whether a backfill id has been recorded. Exported for tests and for the
 * operational check that a deployment finished its data migration. */
export function backfillApplied(db: SessionDatabase, id: string): boolean {
  const row = db
    .select({ id: backfills.id })
    .from(backfills)
    .where(sql`${backfills.id} = ${id}`)
    .get();
  return row !== undefined;
}
