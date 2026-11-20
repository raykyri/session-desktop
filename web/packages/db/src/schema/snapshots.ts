// The durable answer of a node: the record highlights and document edits are
// checked against (`docs/02-domain-model-and-database.md` §3.3, §5.2).

import type { Turn } from "@session/shared";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import type { RunOutcome } from "../json.js";

import { nodes } from "./nodes.js";

export const responseSnapshots = sqliteTable("response_snapshots", {
  nodeId: text("node_id")
    .primaryKey()
    .references(() => nodes.id, { onDelete: "cascade" }),
  /** Lowercase sha256 hex of the canonical JSON of `turns_json`. */
  revision: text("revision").notNull(),
  turnsJson: text("turns_json", { mode: "json" }).$type<Turn[]>().notNull(),
  /** Set when the attempt that produced these turns settled. Boot
   * reconciliation adopts it for a node left active by a crash. */
  outcomeJson: text("outcome_json", { mode: "json" }).$type<RunOutcome>(),
  byteSize: integer("byte_size").notNull(),
  version: integer("version").notNull().default(1),
  updatedAt: integer("updated_at").notNull(),
});
