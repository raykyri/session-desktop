import {
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  type Router,
} from "@tanstack/react-router";
import { z } from "zod";

import { LoginPage } from "../routes/login.js";
import {
  AdminPage,
  BookmarksPage,
  EncyclopediaPage,
  HighlightsPage,
  HomePage,
  ResearchPage,
} from "../routes/placeholders.js";
import { SettingsPage } from "../routes/settings.js";

import { AppShell } from "./layout/AppShell.js";

// The desktop persisted several view coordinates in localStorage; on the web
// they are search params, so a reload, a deep link and a second tab all agree
// (ADR-7). Every one is validated, so a hand-edited URL cannot put an
// unrepresentable value into a store.
const workspaceScopeSearchSchema = z.object({
  /** Workspace scope. Absent means the account's default workspace. */
  ws: z.string().optional(),
});

const researchSearchSchema = z.object({
  /** The node the document view is showing. */
  node: z.string().optional(),
  /** A highlight to scroll to and focus once the document lands. */
  highlight: z.string().optional(),
  filter: z.enum(["active", "archived", "all"]).optional(),
});

export type WorkspaceScopeSearch = z.infer<typeof workspaceScopeSearchSchema>;
export type ResearchSearch = z.infer<typeof researchSearchSchema>;

const rootRoute = createRootRoute({ component: Outlet });

/** Sign-in renders outside the shell: there is no sidebar, no stage header and
 * no subscription before a session exists. */
const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: LoginPage,
});

/** A pathless layout route, so every signed-in view shares one `AppShell`
 * instance — and therefore one keydown listener and one overlay stack. */
const shellRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "_shell",
  component: AppShell,
});

const homeRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/",
  validateSearch: workspaceScopeSearchSchema,
  component: HomePage,
});

const bookmarksRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/bookmarks",
  validateSearch: workspaceScopeSearchSchema,
  component: BookmarksPage,
});

const highlightsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/highlights",
  validateSearch: workspaceScopeSearchSchema,
  component: HighlightsPage,
});

const researchRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/r/$treeId",
  validateSearch: researchSearchSchema,
  component: ResearchPage,
});

const encyclopediaRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/e/$slug",
  validateSearch: workspaceScopeSearchSchema,
  component: EncyclopediaPage,
});

const settingsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/settings",
  component: SettingsPage,
});

const adminRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/admin",
  component: AdminPage,
});

/** The kitchen sink (08 §4). Registered only in development and loaded
 * lazily, so the module is a chunk production never references. `import.meta`
 * carries no `env` outside the bundler, and AVA imports this module directly,
 * so the check tolerates its absence. */
const isDevelopment = (import.meta as { env?: { DEV?: boolean } }).env?.DEV === true;

const devRoutes = isDevelopment
  ? [
      createRoute({
        getParentRoute: () => shellRoute,
        path: "/dev/ui",
        component: lazyRouteComponent(() => import("../routes/devUi.js"), "DevUiPage"),
      }),
    ]
  : [];

export const routeTree = rootRoute.addChildren([
  loginRoute,
  shellRoute.addChildren([
    homeRoute,
    bookmarksRoute,
    highlightsRoute,
    researchRoute,
    encyclopediaRoute,
    settingsRoute,
    adminRoute,
    ...devRoutes,
  ]),
]);

export function createAppRouter(
  options?: Partial<Parameters<typeof createRouter>[0]>,
): Router<typeof routeTree, "never", true> {
  return createRouter({ routeTree, defaultPreload: "intent", ...options }) as Router<
    typeof routeTree,
    "never",
    true
  >;
}

export const router = createAppRouter();

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
