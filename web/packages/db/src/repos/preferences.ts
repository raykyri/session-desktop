// Per-account settings (`docs/06-auth-and-users.md` §6): the appearance
// settings, the research launch instruction, the account and notification
// settings of the spaces API (`/api/me/settings`) and the payer settings of
// `/api/me/usage` (phase 2a).

import type { UserSettings } from "@session/shared";
import { DEFAULT_USER_SETTINGS, userSettingsSchema } from "@session/shared";
import { eq } from "drizzle-orm";

import type { SessionDatabase } from "../connection.js";
import { transact } from "../connection.js";
import { parseJsonColumn } from "../json.js";
import { userPreferences, type AccountSettings } from "../schema/preferences.js";
import { now } from "../time.js";

export type { AccountSettings };

/** The desktop capped the launch instruction at 4 KiB before wrapping it into
 * the system prompt; the cap is enforced here so a direct repository call
 * cannot store more than a prompt can carry. */
export const MAX_RESEARCH_LAUNCH_INSTRUCTION_BYTES = 4096;

export const DEFAULT_ACCOUNT_SETTINGS: AccountSettings = {
  email: "",
  emailNew: null,
  exportAt: null,
  emailOn: true,
  types: {},
  spaces: {},
};

export interface StoredPreferences {
  settings: UserSettings;
  researchLaunchInstruction: string | null;
  account: AccountSettings;
  defaultKeyId: string | null;
  movedSeen: boolean;
  updatedAt: number;
}

function rowToPreferences(row: typeof userPreferences.$inferSelect): StoredPreferences {
  return {
    settings: parseJsonColumn(
      userSettingsSchema,
      row.settingsJson,
      "user_preferences.settings_json",
    ),
    researchLaunchInstruction: row.researchLaunchInstruction,
    account: { ...DEFAULT_ACCOUNT_SETTINGS, ...row.accountJson },
    defaultKeyId: row.defaultKeyId,
    movedSeen: row.movedSeen,
    updatedAt: row.updatedAt,
  };
}

/** Reads the account's preferences, creating the defaults on first access so
 * every later write is a plain update. */
export function ensure(db: SessionDatabase, userId: string): StoredPreferences {
  return transact(db, (tx) => {
    const existing = tx
      .select()
      .from(userPreferences)
      .where(eq(userPreferences.userId, userId))
      .get();
    if (existing) {
      return rowToPreferences(existing);
    }
    const inserted = tx
      .insert(userPreferences)
      .values({
        userId,
        settingsJson: DEFAULT_USER_SETTINGS,
        researchLaunchInstruction: null,
        accountJson: DEFAULT_ACCOUNT_SETTINGS,
        defaultKeyId: null,
        movedSeen: false,
        updatedAt: now(),
      })
      .returning()
      .get();
    return rowToPreferences(inserted);
  });
}

export interface PreferencesPatch {
  settings?: Partial<UserSettings>;
  researchLaunchInstruction?: string | null;
  account?: Partial<AccountSettings>;
  defaultKeyId?: string | null;
  movedSeen?: boolean;
}

/** Merges a patch into the stored preferences. Settings merge field by field
 * so a client that supports fewer fields than the server cannot erase the rest. */
export function update(
  db: SessionDatabase,
  userId: string,
  patch: PreferencesPatch,
): StoredPreferences {
  return transact(db, (tx) => {
    const current = ensure(tx, userId);
    const settings = userSettingsSchema.parse({ ...current.settings, ...patch.settings });
    const instruction =
      patch.researchLaunchInstruction === undefined
        ? current.researchLaunchInstruction
        : normalizeLaunchInstruction(patch.researchLaunchInstruction);
    const row = tx
      .update(userPreferences)
      .set({
        settingsJson: settings,
        researchLaunchInstruction: instruction,
        accountJson: { ...current.account, ...patch.account },
        defaultKeyId: patch.defaultKeyId === undefined ? current.defaultKeyId : patch.defaultKeyId,
        movedSeen: patch.movedSeen ?? current.movedSeen,
        updatedAt: now(),
      })
      .where(eq(userPreferences.userId, userId))
      .returning()
      .get();
    return rowToPreferences(row);
  });
}

/** Trims, drops an empty instruction to null, and rejects one over the cap. */
export function normalizeLaunchInstruction(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    return null;
  }
  if (Buffer.byteLength(trimmed, "utf8") > MAX_RESEARCH_LAUNCH_INSTRUCTION_BYTES) {
    throw new Error(
      `Research instructions exceed maximum allowed size of ${MAX_RESEARCH_LAUNCH_INSTRUCTION_BYTES} bytes.`,
    );
  }
  return trimmed;
}
