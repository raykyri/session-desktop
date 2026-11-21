// The tRPC root router. `AppRouter` is the only thing the client imports from
// this package, and it imports it as a type: ADR-1 forbids a runtime edge from
// `client` to `server`.
//
// The research routers (`research`, `workspaces`, `folders`, `feed`,
// `sharing`, `drafts` and the others over the research tables) were removed
// with the research client (plan `01` A2). Replicated data goes through the
// sync routes (`01` §6); the online-only procedures of `01` §6 are added here.

import { router } from "./base.js";
import { adminRouter, authRouter, settingsRouter, usageRouter } from "./routers/account.js";
import { accountInvitesRouter, accountRouter, membersRouter } from "./routers/membership.js";
import { systemRouter } from "./routers/system.js";

export const appRouter = router({
  system: systemRouter,
  auth: authRouter,
  settings: settingsRouter,
  usage: usageRouter,
  admin: adminRouter,
  account: accountRouter,
  accountInvites: accountInvitesRouter,
  members: membersRouter,
});

export type AppRouter = typeof appRouter;

export { createCallerFactory } from "./base.js";
