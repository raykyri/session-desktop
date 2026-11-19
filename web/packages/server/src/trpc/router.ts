// The tRPC root router: the account procedures the web client's shell uses
// (phase 2a). Spaces are served by the sync protocol (`sync/routes.ts`).
// `AppRouter` is the only thing the client imports from this package, and it
// imports it as a type: ADR-1 forbids a runtime edge from `client` to
// `server`.

import { router } from "./base.js";
import { adminRouter, authRouter, settingsRouter, usageRouter } from "./routers/account.js";
import { systemRouter } from "./routers/system.js";

export const appRouter = router({
  system: systemRouter,
  auth: authRouter,
  settings: settingsRouter,
  usage: usageRouter,
  admin: adminRouter,
});

export type AppRouter = typeof appRouter;

export { createCallerFactory } from "./base.js";
