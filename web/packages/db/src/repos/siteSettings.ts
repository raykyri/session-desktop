// Site-wide settings a site admin changes at runtime
// (`03-agents-and-research.md` K15): the default model and the default
// effort. Values are JSON; which keys exist and what they may hold is the
// server's rule (`server/src/models/siteDefaults.ts`).

import { eq } from "drizzle-orm";

import type { SessionDatabase } from "../connection.js";
import { siteSettings } from "../schema/apiKeys.js";
import { now } from "../time.js";

export type SiteSettingKey = "default_model" | "default_effort";

/** The stored value, or undefined when the key was never set. */
export function get(db: SessionDatabase, key: SiteSettingKey): unknown {
  return db.select().from(siteSettings).where(eq(siteSettings.key, key)).get()?.valueJson;
}

export function set(
  db: SessionDatabase,
  key: SiteSettingKey,
  value: unknown,
  updatedBy: string | null,
  at: number = now(),
): void {
  db.insert(siteSettings)
    .values({ key, valueJson: value, updatedBy, updatedAt: at })
    .onConflictDoUpdate({
      target: siteSettings.key,
      set: { valueJson: value, updatedBy, updatedAt: at },
    })
    .run();
}
