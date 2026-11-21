// The run tables beside the records (`01` D3; `03` E2, T3, T4): `run_live`,
// the in-flight checkpoint of an attempt, and `run_resumes`, the automatic
// resumes an attempt had. Neither is replicated: a checkpoint is written at
// most once a second while a run streams, and nothing of it reaches the
// change log. Each method is one statement in its own implicit transaction.

import type SqliteDatabase from "better-sqlite3";

import type { SessionDatabase } from "../connection.js";

/** An attempt's in-flight checkpoint. */
export interface RunLiveRow {
  runId: string;
  attempt: number;
  /** The mapper's id of the turn still streaming. */
  turnId: string;
  /** The number its `turn` record will have when it commits. */
  n: number;
  /** Its text so far, as Markdown. */
  md: string;
  /** The `seq` of the last delta the text includes. */
  seq: number;
  updatedAt: number;
}

interface Row {
  run_id: string;
  attempt: number;
  turn_id: string;
  n: number;
  md: string;
  seq: number;
  updated_at: number;
}

export class RunTables {
  readonly #s;

  constructor(db: SessionDatabase | SqliteDatabase.Database) {
    const c = "$client" in db ? db.$client : db;
    this.#s = {
      put: c.prepare(
        `INSERT INTO run_live (run_id, attempt, turn_id, n, md, seq, updated_at)
         VALUES (@runId, @attempt, @turnId, @n, @md, @seq, @updatedAt)
         ON CONFLICT (run_id, attempt) DO UPDATE SET turn_id = excluded.turn_id, n = excluded.n,
           md = excluded.md, seq = excluded.seq, updated_at = excluded.updated_at`,
      ),
      get: c.prepare<[string, number], Row>(
        "SELECT * FROM run_live WHERE run_id = ? AND attempt = ?",
      ),
      drop: c.prepare<[string, number]>("DELETE FROM run_live WHERE run_id = ? AND attempt = ?"),
      dropRun: c.prepare<[string]>("DELETE FROM run_live WHERE run_id = ?"),
      resumes: c.prepare<[string, number], { resumes: number }>(
        "SELECT resumes FROM run_resumes WHERE run_id = ? AND attempt = ?",
      ),
      setResumes: c.prepare<[string, number, number]>(
        `INSERT INTO run_resumes (run_id, attempt, resumes) VALUES (?, ?, ?)
         ON CONFLICT (run_id, attempt) DO UPDATE SET resumes = excluded.resumes`,
      ),
    };
  }

  putLive(row: RunLiveRow): void {
    this.#s.put.run({ ...row });
  }

  live(runId: string, attempt: number): RunLiveRow | null {
    const r = this.#s.get.get(runId, attempt);
    return r
      ? {
          runId: r.run_id,
          attempt: r.attempt,
          turnId: r.turn_id,
          n: r.n,
          md: r.md,
          seq: r.seq,
          updatedAt: r.updated_at,
        }
      : null;
  }

  /** Delete one attempt's checkpoint, or every attempt's. */
  dropLive(runId: string, attempt?: number): void {
    if (attempt === undefined) this.#s.dropRun.run(runId);
    else this.#s.drop.run(runId, attempt);
  }

  resumes(runId: string, attempt: number): number {
    return this.#s.resumes.get(runId, attempt)?.resumes ?? 0;
  }

  setResumes(runId: string, attempt: number, resumes: number): void {
    this.#s.setResumes.run(runId, attempt, resumes);
  }
}
