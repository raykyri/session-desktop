// Per-account settings. The desktop kept these in localStorage and a Rust
// preferences file; on the web they follow the account
// (`docs/06-auth-and-users.md` §6).

import type { UserSettings } from "@session/shared";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { users } from "./users.js";

export const userPreferences = sqliteTable("user_preferences", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  settingsJson: text("settings_json", { mode: "json" }).$type<UserSettings>().notNull(),
  /** Wrapped and neutralized into the system prompt by the runtime; capped at
   * 4 KiB by the shared validator. */
  researchLaunchInstruction: text("research_launch_instruction"),
  defaultWorkspaceId: text("default_workspace_id"),
  updatedAt: integer("updated_at").notNull(),
});
