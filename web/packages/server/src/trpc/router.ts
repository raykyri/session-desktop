// The tRPC root router. `AppRouter` is the only thing the client imports from
// this package, and it imports it as a type: ADR-1 forbids a runtime edge from
// `client` to `server`.

import { router } from "./base.js";
import { adminRouter, authRouter, settingsRouter, usageRouter } from "./routers/account.js";
import { artifactsRouter } from "./routers/artifacts.js";
import { draftsRouter, interfaceDraftsRouter } from "./routers/drafts.js";
import { eventsRouter } from "./routers/events.js";
import { feedRouter } from "./routers/feed.js";
import { highlightsRouter, recapsRouter } from "./routers/highlights.js";
import { notificationsRouter } from "./routers/notifications.js";
import { followupProcedures, researchRouter } from "./routers/research/index.js";
import { invitesRouter, sharingRouter, subscriptionsRouter } from "./routers/sharing.js";
import { systemRouter } from "./routers/system.js";
import { foldersRouter, workspacesRouter } from "./routers/workspaces.js";

export const appRouter = router({
  system: systemRouter,
  auth: authRouter,
  settings: settingsRouter,
  interfaceDrafts: interfaceDraftsRouter,
  drafts: draftsRouter,
  usage: usageRouter,
  admin: adminRouter,
  workspaces: workspacesRouter,
  folders: foldersRouter,
  research: researchRouter,
  followups: router(followupProcedures),
  highlights: highlightsRouter,
  recaps: recapsRouter,
  feed: feedRouter,
  sharing: sharingRouter,
  invites: invitesRouter,
  subscriptions: subscriptionsRouter,
  notifications: notificationsRouter,
  artifacts: artifactsRouter,
  events: eventsRouter,
});

export type AppRouter = typeof appRouter;

export { createCallerFactory } from "./base.js";
