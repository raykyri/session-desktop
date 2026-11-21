// Members' own provider keys, their billing setting, and the site-wide
// settings a site admin changes at runtime
// (`15-implementation-plan/03-agents-and-research.md` K4, K7, K15; ADR-23).
// None of these tables is replicated: they are read and written through
// online-only tRPC procedures (ADR-19).

import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { users } from "./users.js";

/**
 * One key per member and provider. `sealed` is the key encrypted with
 * AES-256-GCM under `SESSION_SECRET_KEY`, bound to the member and provider
 * (`server/src/secretBox.ts`); the raw key is never stored. `last4` is what
 * the Usage page shows after the provider's prefix.
 */
export const apiKeys = sqliteTable(
  "api_keys",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider", { enum: ["anthropic", "openai"] }).notNull(),
    sealed: text("sealed").notNull(),
    last4: text("last4").notNull(),
    /** `valid` when saved (the provider accepted it during the save);
     * `invalid` once a run found it rejected. */
    status: text("status", { enum: ["valid", "invalid"] }).notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.provider] })],
);

/** What happens when a member's included tokens run out (`03` K7). A member
 * without a row pauses. */
export const usageBilling = sqliteTable("usage_billing", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  mode: text("mode", { enum: ["pause", "key"] }).notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/** Site-wide settings (`03` K15): `default_model` and `default_effort`. An
 * absent key reads as the registry's default. */
export const siteSettings = sqliteTable("site_settings", {
  key: text("key").primaryKey(),
  valueJson: text("value_json", { mode: "json" }).$type<unknown>().notNull(),
  updatedBy: text("updated_by").references(() => users.id, { onDelete: "set null" }),
  updatedAt: integer("updated_at").notNull(),
});
