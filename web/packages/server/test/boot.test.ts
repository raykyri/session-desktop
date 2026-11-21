// The boot steps (`01` S5, D6; `03` K1, E2): the restore check, then open
// usage rows closed, then running runs interrupted, then maintenance; a
// restored database file boots with every log's epoch bumped.

import { copyFileSync } from "node:fs";
import { join } from "node:path";

import { closeDatabase, openDatabase } from "@session/db";
import test from "ava";

import { bootServer } from "../src/boot.js";
import { createLogger } from "../src/logger.js";
import { ZERO_COUNTS, weekOf } from "../src/runs/ledger.js";
import { SqliteLedger } from "../src/runs/sqliteLedger.js";
import { SyncService } from "../src/sync/service.js";

import { createHarness } from "./helpers.js";
import { MODEL, channels, newId } from "./syncHttp.js";

const logger = createLogger({ level: "error", write: () => undefined });

test("boot: the restore check, open usage rows, running runs, then maintenance", async (t) => {
  const h = createHarness(t);
  const { mona, open } = await channels(h);
  const r = (await mona.ok("threads.create", {
    id: newId(),
    space: open,
    kind: "ask",
    q: "Why?",
    ...MODEL,
  })) as { run: string };
  h.sync.server.serverApply({ me: "" }, (tx) => {
    const run = tx.byKey(`run:${r.run}`);
    if (run?.kind === "run") tx.put({ ...run, status: "running" });
  });
  const ledger = new SqliteLedger(h.db);
  ledger.open({
    runId: r.run,
    attempt: 1,
    userId: mona.user.id,
    payer: "included",
    week: weekOf(Date.now()),
    kind: "research",
    provider: "anthropic",
    model: "claude-fable",
    cachedInputRatio: 0.1,
    counts: { ...ZERO_COUNTS, inputTokens: 5 },
    openedAt: Date.now(),
  });
  const report = bootServer({ databasePath: h.config.databasePath, sync: h.sync, ledger, logger });
  t.deepEqual(report.steps, [
    "restore check",
    "close open usage rows",
    "interrupt running runs",
    "start maintenance",
  ]);
  t.is(report.closedRows, 1);
  t.is(report.interrupted, 1);
  // the first boot of a file records its generation; the next bumps nothing
  t.not(report.restore.current, null);
  const again = bootServer({ databasePath: h.config.databasePath, sync: h.sync, ledger, logger });
  t.like(again, { closedRows: 0, interrupted: 0, restore: { replaced: false } });
});

test("boot: a restored database file bumps every epoch, and a cursor from before resyncs", async (t) => {
  const h = createHarness(t);
  const { mona, open } = await channels(h);
  bootServer({
    databasePath: h.config.databasePath,
    sync: h.sync,
    ledger: new SqliteLedger(h.db),
    logger,
  });
  const cursor = (await mona.snapshot(`space:${open}`)).cursor;
  h.db.$client.pragma("wal_checkpoint(TRUNCATE)");
  const restored = join(h.directory, "restored.db");
  copyFileSync(h.config.databasePath, restored);
  const db = openDatabase(restored);
  t.teardown(() => closeDatabase(db));
  const sync = new SyncService({ db, config: h.config, logger });
  t.teardown(() => sync.drain());
  const report = bootServer({ databasePath: restored, sync, ledger: new SqliteLedger(db), logger });
  t.true(report.restore.replaced);
  t.deepEqual(sync.server.pull({ u: "mona" }, `space:${open}`, cursor), { resync: true });
});
