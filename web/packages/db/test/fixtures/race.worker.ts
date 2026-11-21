// One side of a race in `invites.test.ts`: opens its own connection to the
// test database, waits at a shared barrier until every side is ready, then
// runs one repository call and posts its outcome. Separate threads with
// separate connections are what two server processes, or a future pool,
// would be; inside one connection better-sqlite3 runs calls one at a time.

import { parentPort, workerData } from "node:worker_threads";

import { accountInvites, closeDatabase, openDatabase } from "../../src/index.js";

interface RaceInput {
  path: string;
  barrier: SharedArrayBuffer;
  parties: number;
  op: "activate" | "create";
  userId: string;
  handle?: string;
}

const input = workerData as RaceInput;
// The test migrated the database before starting the workers.
const db = openDatabase(input.path, { skipMigrations: true });
const gate = new Int32Array(input.barrier);
Atomics.add(gate, 0, 1);
while (Atomics.load(gate, 0) < input.parties) {
  Atomics.wait(gate, 0, Atomics.load(gate, 0), 5);
}
try {
  const outcome =
    input.op === "activate"
      ? accountInvites.activate(db, {
          userId: input.userId,
          handle: input.handle ?? "",
          displayName: "Racer",
        })
      : accountInvites.create(db, {
          createdBy: input.userId,
          encrypt: (code) => `enc:${code.length}`,
        });
  parentPort?.postMessage({ ok: outcome.ok, reason: outcome.ok ? null : outcome.reason });
} catch (error) {
  parentPort?.postMessage({ ok: false, reason: `threw: ${String(error)}` });
} finally {
  closeDatabase(db);
}
