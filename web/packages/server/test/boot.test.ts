// The boot steps (`01` S5, D6; `03` K1, E2), by their effects: the restore
// check records the generation, open usage rows close with ending `boot`,
// running runs become `interrupted` through the change log, and the
// maintenance runs the retention at once; a restored database file boots
// with a new history id.

import { copyFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { checkRestore, closeDatabase, databaseGeneration, openDatabase } from "@session/db";
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
  // the file's generation was recorded at an earlier boot
  checkRestore(h.sync.store, databaseGeneration(h.config.databasePath), Date.now());
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
  // an answer past its 7 days, which the retention at boot removes
  h.db.$client
    .prepare(
      "INSERT INTO sync_answers (u, mutation_id, digest, result_json, at) VALUES ('mona', ?, 'd', '{}', ?)",
    )
    .run(newId(), Date.now() - 8 * 24 * 3600 * 1000);
  const cursor = (await mona.snapshot(`space:${open}`)).cursor;
  const report = bootServer({ databasePath: h.config.databasePath, sync: h.sync, ledger, logger });
  // the maintenance's checkpoint truncated the WAL
  t.is(statSync(`${h.config.databasePath}-wal`).size, 0);
  t.is(report.closedRows, 1);
  t.is(report.interrupted, 1);
  // the usage row is closed by the boot
  t.deepEqual(
    h.db.$client.prepare("SELECT state, ending FROM usage_events WHERE run_id = ?").get(r.run),
    { state: "closed", ending: "boot" },
  );
  // the run is interrupted, and a reader pulls the change
  t.like(h.sync.store.byKey(`run:${r.run}`), {
    status: "interrupted",
    fail: { why: "interrupted" },
  });
  const p = h.sync.server.pull({ u: "mona" }, `space:${open}`, cursor);
  t.true("changes" in p && p.changes.some((c) => c.key === `run:${r.run}`));
  // the generation is recorded, and the retention ran
  t.is(
    (
      h.db.$client
        .prepare("SELECT value FROM server_meta WHERE key = 'litestream_generation'")
        .get() as { value: string }
    ).value,
    report.restore.current ?? "",
  );
  t.is(
    (
      h.db.$client.prepare("SELECT count(*) AS n FROM sync_answers WHERE digest = 'd'").get() as {
        n: number;
      }
    ).n,
    0,
  );
  // the first boot of a file records its generation; the next bumps nothing
  t.not(report.restore.current, null);
  const again = bootServer({ databasePath: h.config.databasePath, sync: h.sync, ledger, logger });
  t.like(again, { closedRows: 0, interrupted: 0, restore: { replaced: false } });
});

test("boot: a restored database file gets a new history id, and a cursor from before resyncs", async (t) => {
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
