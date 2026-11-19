// Per-account settings (`docs/06-auth-and-users.md` §6): the appearance
// settings (`UserSettings`), the research launch instruction, the account
// and notification settings the spaces API serves (`/api/me/settings`), and
// the payer settings of `/api/me/usage` (the default API key, and whether
// the person saw the note that their key now pays).

import type { UserSettings } from "@session/shared";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { users } from "./users.js";

/** The account settings of `/api/me/settings` (`userSettingsSchema` in the
 * spaces API), as stored. */
export interface AccountSettings {
  email: string;
  emailNew: string | null;
  exportAt: string | null;
  emailOn: boolean;
  types: Record<string, boolean>;
  spaces: Record<string, "all" | "mentions" | "off">;
}

export const userPreferences = sqliteTable("user_preferences", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  settingsJson: text("settings_json", { mode: "json" }).$type<UserSettings>().notNull(),
  /** Wrapped and neutralized into the system prompt by the runtime; capped at
   * 4 KiB by the shared validator. */
  researchLaunchInstruction: text("research_launch_instruction"),
  accountJson: text("account_json", { mode: "json" }).$type<AccountSettings>().notNull(),
  /** The API key that pays after the included tokens (null: the first valid
   * key). */
  defaultKeyId: text("default_key_id"),
  movedSeen: integer("moved_seen", { mode: "boolean" }).notNull().default(false),
  updatedAt: integer("updated_at").notNull(),
});
