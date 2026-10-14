// Drafts (`docs/02-domain-model-and-database.md` §3.1). Two kinds:
// interface drafts, the opaque client state that has to survive a reload on
// another device (composer text, mostly), and research drafts, the saved list
// of unsent questions shown in the Drafts place. Both are per person.

import type { ResearchMessageAttachment } from "@session/shared";
import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { users } from "./users.js";
import { workspaces } from "./workspaces.js";

export const interfaceDrafts = sqliteTable(
  "interface_drafts",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Opaque to the server; ≤ 128 bytes. */
    key: text("key").notNull(),
    /** ≤ 1 MiB. The desktop allowed 12 MiB because the value never left the
     * machine. */
    value: text("value").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.key] })],
);

/** The desktop's `ResearchDraft`: an unsent question saved from the composer,
 * scoped to one workspace. Private to the person who saved it. */
export const researchDrafts = sqliteTable(
  "research_drafts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    prompt: text("prompt").notNull(),
    /** Image attachments only. */
    attachmentsJson: text("attachments_json", { mode: "json" })
      .$type<ResearchMessageAttachment[]>()
      .notNull()
      .default(sql`'[]'`),
    /** Order in the Drafts list; 0 is the top. */
    position: integer("position").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("research_drafts_order_idx").on(table.userId, table.workspaceId, table.position),
  ],
);
