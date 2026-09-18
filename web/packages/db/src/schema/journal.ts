// Journal entries: saved links and X posts
// (`docs/02-domain-model-and-database.md` §3.4, §5.12).
//
// The entry is stored whole in `entry_json`; the columns beside it are
// projections the feed and hydration query on, never a second source of truth.

import type { JournalEntry } from "@session/shared";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { users } from "./users.js";

export const journalEntries = sqliteTable(
  "journal_entries",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["link", "tweet"] }).notNull(),
    createdAt: integer("created_at").notNull(),
    url: text("url"),
    tweetId: text("tweet_id"),
    hydration: text("hydration", { enum: ["pending", "ok", "failed"] }),
    text: text("text"),
    entryJson: text("entry_json", { mode: "json" }).$type<JournalEntry>().notNull(),
  },
  (table) => [index("journal_entries_user_idx").on(table.userId, table.createdAt, table.id)],
);
