// The server half of the sync core on SQLite (`15-implementation-plan/
// 01-architecture-and-data.md` D1-D3, D6): the replicated records, the sync
// bookkeeping, and the server-only tables beside them. Migration
// `0005_spaces.sql` creates these tables. `src/sync/store.ts` is the only
// code that reads or writes the first group; `put`, `create` and `del` of a
// mutator's transaction reach `records` only through its `putRecord` and
// `deleteRecord` (`01` D1).

import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * D1: every replicated record, in one table with its stored shape as JSON.
 * `sp`, `th` and `u` are the index columns of `indexOf` (`@session/mutators`):
 * the space, the thread, and the person whose user log holds the record (else
 * its author or maker). `uniq` holds the value of a record's unique lookup
 * (a space's name, a channel invite link's code), unique per kind.
 */
export const records = sqliteTable(
  "records",
  {
    key: text("key").primaryKey(),
    kind: text("kind").notNull(),
    sp: text("sp"),
    th: text("th"),
    u: text("u"),
    uniq: text("uniq"),
    /** The stored shape, validated with the record's zod schema when written
     * and when read. */
    body: text("body").notNull(),
    rev: integer("rev").notNull(),
    /** The log version of the commit that created the record (list order). */
    createdV: integer("created_v").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("records_kind_sp_idx").on(table.kind, table.sp, table.createdV),
    index("records_kind_th_idx").on(table.kind, table.th, table.createdV),
    index("records_kind_u_idx").on(table.kind, table.u),
    uniqueIndex("records_kind_uniq_unique").on(table.kind, table.uniq),
  ],
);

/** D2: one row per (log, key), holding key, operation and version only; a
 * write replaces the key's row. `log` is `space:<id>` or `user:<handle>`. */
export const changeLog = sqliteTable(
  "change_log",
  {
    log: text("log").notNull(),
    key: text("key").notNull(),
    op: text("op", { enum: ["put", "del"] }).notNull(),
    version: integer("version").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.log, table.key] }),
    index("change_log_version_idx").on(table.log, table.version),
    index("change_log_key_idx").on(table.key, table.op),
  ],
);

/** D2: the server's newest version, one row (`id` 1). Versions come from one
 * sequence for the whole server and never leave it. */
export const serverHead = sqliteTable("server_head", {
  id: integer("id").primaryKey(),
  version: integer("version").notNull(),
});

/** D2, D6: a row only for a log whose history was replaced: how many times,
 * and the version the current history began at. */
export const logEpochs = sqliteTable("log_epochs", {
  log: text("log").primaryKey(),
  epoch: integer("epoch").notNull(),
  startVersion: integer("start_version").notNull(),
});

/** D2: every id and record key ever written, with its last rev. Never
 * pruned, so an id is never used twice. */
export const registry = sqliteTable("registry", {
  name: text("name").primaryKey(),
  lastRev: integer("last_rev").notNull(),
});

/** D2: what a deleted record leaves for 30 days: its key, kind and audience
 * (space, person, author or maker), no text. Its rev is in `registry`. */
export const tombstones = sqliteTable(
  "tombstones",
  {
    key: text("key").primaryKey(),
    kind: text("kind").notNull(),
    sp: text("sp"),
    person: text("person"),
    by: text("by_u"),
    deletedAt: integer("deleted_at").notNull(),
  },
  (table) => [index("tombstones_deleted_idx").on(table.deletedAt)],
);

/** D2: registered sync clients, by the handle they are bound to. A web
 * client id lives 7 days idle; registrations in the past day are counted
 * from `created_at` (`01` Y3). */
export const syncClients = sqliteTable(
  "sync_clients",
  {
    clientId: text("client_id").primaryKey(),
    u: text("u").notNull(),
    lastSeq: integer("last_seq").notNull(),
    createdAt: integer("created_at").notNull(),
    lastUsedAt: integer("last_used_at").notNull(),
  },
  (table) => [
    index("sync_clients_u_idx").on(table.u, table.createdAt),
    index("sync_clients_used_idx").on(table.lastUsedAt),
  ],
);

/** D2: answers recorded under (user, mutation id), kept 7 days. `digest`
 * hashes the name and canonical input; `*` marks an answer stored under an id
 * a reminted envelope replaced. */
export const syncAnswers = sqliteTable(
  "sync_answers",
  {
    u: text("u").notNull(),
    mutationId: text("mutation_id").notNull(),
    digest: text("digest").notNull(),
    resultJson: text("result_json").notNull(),
    at: integer("at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.u, table.mutationId] }),
    index("sync_answers_at_idx").on(table.at),
  ],
);

/** D2: answers recorded under (client, seq), for a mutation id that is
 * malformed or already used with another payload. */
export const syncSeqAnswers = sqliteTable(
  "sync_seq_answers",
  {
    clientId: text("client_id").notNull(),
    seq: integer("seq").notNull(),
    digest: text("digest").notNull(),
    resultJson: text("result_json").notNull(),
    at: integer("at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.clientId, table.seq] }),
    index("sync_seq_answers_at_idx").on(table.at),
  ],
);

/** D3: server facts that are not records: the Litestream generation id the
 * database was last booted with (D6). */
export const serverMeta = sqliteTable("server_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/** D3, `01` C1: the true save count of a thread in a private channel. The
 * replicated counts record serves 0 until this reaches 3. */
export const saveCounts = sqliteTable("save_counts", {
  th: text("th").primaryKey(),
  saves: integer("saves").notNull(),
});

/** D3, `03` T3, T4: the in-flight checkpoint text of a run's attempt, at
 * most 1 s or 4 KiB behind the stream: the turn still streaming (`n`, the
 * number its `turn` record will have) and the `seq` of the last delta its
 * text includes. Written outside the change log; deleted when the attempt
 * ends, except an interrupted one, which keeps it so the resumed stream
 * continues its delta sequence. */
export const runLive = sqliteTable(
  "run_live",
  {
    runId: text("run_id").notNull(),
    attempt: integer("attempt").notNull(),
    turnId: text("turn_id").notNull(),
    n: integer("n").notNull().default(0),
    md: text("md").notNull(),
    seq: integer("seq").notNull().default(0),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.runId, table.attempt] })],
);

/** D3, `03` E2: how many times boot resumed an interrupted attempt; at most
 * two, then the run stays `interrupted` with Run again. */
export const runResumes = sqliteTable(
  "run_resumes",
  {
    runId: text("run_id").notNull(),
    attempt: integer("attempt").notNull(),
    resumes: integer("resumes").notNull(),
  },
  (table) => [primaryKey({ columns: [table.runId, table.attempt] })],
);
