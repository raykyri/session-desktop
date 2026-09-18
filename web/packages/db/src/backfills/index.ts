// Versioned data migrations that SQL cannot express
// (`docs/02-domain-model-and-database.md` §4). `openDatabase()` runs these
// after `migrate()`, in declaration order, each inside its own transaction,
// and records the ones that ran in `backfills`.
//
// The list is empty: the first schema has no history to rewrite. It exists so
// the first backfill is a one-line addition rather than a new mechanism
// invented under pressure.

import { sql } from "drizzle-orm";

import type { SessionDatabase } from "../connection.js";
import { backfills } from "../schema/backfills.js";
import { now } from "../time.js";

export interface Backfill {
  /** Stable identifier, recorded in `backfills`. Never reused or renamed. */
  id: string;
  /** What the step does, for the operator reading a boot log. */
  description: string;
  run: (db: SessionDatabase) => void;
}

export const BACKFILLS: readonly Backfill[] = [];

/** Applies every backfill this build knows that the database has not recorded.
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
