// The public catalog is the first admin account, else the oldest account.
// Guests read that owner's workspaces, threads, and encyclopedia. The Home feed is global.
// Signed-in callers still read their own rows. Mutations stay behind
// `protectedProcedure` (`06-auth-and-users.md` §4).

import { users } from "@session/db";
import type { SessionDatabase } from "@session/db";
import type { User } from "@session/shared";

export function catalogUserId(ctx: { db: SessionDatabase; user: User | null }): string | null {
  if (ctx.user !== null) return ctx.user.id;
  const accounts = users.listUsers(ctx.db);
  return accounts.find((account) => account.isAdmin)?.id ?? accounts[0]?.id ?? null;
}
