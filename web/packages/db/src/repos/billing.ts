// What happens when a member's included tokens run out (`03-agents-and-research.md`
// K7): `pause` (the default, no row) or `key` (continue on the member's
// Anthropic key). The rule that `key` needs a valid Anthropic key is the
// server's; this module only stores the choice.

import { eq } from "drizzle-orm";

import type { SessionDatabase } from "../connection.js";
import { usageBilling } from "../schema/apiKeys.js";
import { now } from "../time.js";

export type BillingMode = "pause" | "key";

export function get(db: SessionDatabase, userId: string): BillingMode {
  return (
    db.select().from(usageBilling).where(eq(usageBilling.userId, userId)).get()?.mode ?? "pause"
  );
}

export function set(
  db: SessionDatabase,
  userId: string,
  mode: BillingMode,
  at: number = now(),
): BillingMode {
  db.insert(usageBilling)
    .values({ userId, mode, updatedAt: at })
    .onConflictDoUpdate({ target: usageBilling.userId, set: { mode, updatedAt: at } })
    .run();
  return mode;
}
