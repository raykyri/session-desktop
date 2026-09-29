// The tRPC root router. `AppRouter` is the only thing the client imports from
// this package, and it imports it as a type: ADR-1 forbids a runtime edge from
// `client` to `server`.

import { router } from "./base.js";
import {
  adminRouter,
  authRouter,
  draftsRouter,
  settingsRouter,
  usageRouter,
} from "./routers/account.js";
import { artifactsRouter, eventsRouter } from "./routers/events.js";
import { highlightsRouter, recapsRouter } from "./routers/highlights.js";
import { feedRouter, journalRouter } from "./routers/journal.js";
import { documentsRouter, researchRouter } from "./routers/research.js";
import { systemRouter } from "./routers/system.js";
import { foldersRouter, workspacesRouter } from "./routers/workspaces.js";

export const appRouter = router({
  system: systemRouter,
  auth: authRouter,
  settings: settingsRouter,
  drafts: draftsRouter,
  usage: usageRouter,
  admin: adminRouter,
  workspaces: workspacesRouter,
  folders: foldersRouter,
  research: researchRouter,
  documents: documentsRouter,
  highlights: highlightsRouter,
  recaps: recapsRouter,
  feed: feedRouter,
  journal: journalRouter,
  artifacts: artifactsRouter,
  events: eventsRouter,
});

export type AppRouter = typeof appRouter;

export { createCallerFactory } from "./base.js";
