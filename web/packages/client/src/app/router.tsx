import type { QueryClient } from "@tanstack/react-query";
import {
  Outlet,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  lazyRouteComponent,
  redirect,
  type Router,
} from "@tanstack/react-router";
import { z } from "zod";

import { queryKeys } from "../api/cache.js";
import {
  encyclopediaQueryOptions,
  foldersQueryOptions,
  meQueryOptions,
  runtimeConfigQueryOptions,
  settingsQueryOptions,
  treesQueryOptions,
  workspacesQueryOptions,
} from "../api/queries.js";
import { AdminPage } from "../routes/admin.js";
import { BookmarksPage } from "../routes/bookmarks.js";
import { EncyclopediaPage } from "../routes/encyclopedia.$slug.js";
import { HighlightsPage } from "../routes/highlights.js";
import { HomePage } from "../routes/home.js";
import { LoginPage } from "../routes/login.js";
import { ResearchPage } from "../routes/research.$treeId.js";
import { SettingsPage } from "../routes/settings.js";

import { RouteErrorPanel, RouteNotFoundPanel } from "./RouteBoundary.js";
import { AppShell } from "./layout/AppShell.js";
import { appQueryClient } from "./queryClient.js";

// UI view state is stored in URL query parameters rather than localStorage to ensure deep links and multiple tabs remain synchronized. Validated via Zod schemas to reject invalid inputs.
const workspaceScopeSearchSchema = z.object({
  /** Workspace scope. Absent means the account's default workspace. */
  ws: z.string().optional(),
  /** The sidebar's visibility filter, which is chrome rather than page state
   * but belongs in the URL for the same reason `ws` does (ADR-7, `10` §7). */
  filter: z.enum(["active", "archived", "all"]).optional(),
});

const researchSearchSchema = z.object({
  /** Workspace scope, carried across every route so the sidebar keeps showing
   * the workspace the thread was opened from. */
  ws: z.string().optional(),
  /** The node the document view is showing. */
  node: z.string().optional(),
  /** A highlight to scroll to and focus once the document lands. */
  highlight: z.string().optional(),
  filter: z.enum(["active", "archived", "all"]).optional(),
});

/** Query parameters passed to /login when authentication fails, including redirect target and optional invite code. */
const loginSearchSchema = z.object({
  error: z.string().optional(),
  invite: z.string().optional(),
  redirect: z.string().optional(),
});

export type WorkspaceScopeSearch = z.infer<typeof workspaceScopeSearchSchema>;
export type ResearchSearch = z.infer<typeof researchSearchSchema>;
export type LoginSearch = z.infer<typeof loginSearchSchema>;

export interface RouterContext {
  queryClient: QueryClient;
}

const rootRoute = createRootRouteWithContext<RouterContext>()({ component: Outlet });

/** The kitchen sink (08 §4) is registered only in development and loaded
 * lazily, so the module is a chunk production never references. `import.meta`
 * carries no `env` outside the bundler, and AVA imports this module directly,
 * so the check tolerates its absence. */
const isDevelopment = (import.meta as { env?: { DEV?: boolean } }).env?.DEV === true;

/**
 * Validates return paths after login to ensure redirects stay on the same origin and avoid redirect loops to /login. The server applies the same rule to `return_to`
 * (`auth/github.ts:safeReturnTo`); this one governs the in-app hop, which
 * never reaches the server.
 */
export function safeRedirectPath(value: string | undefined): string | null {
  if (value === undefined || !value.startsWith("/")) return null;
  if (value.startsWith("//") || value.startsWith("/\\")) return null;
  if (value === "/login" || value.startsWith("/login?")) return null;
  return value;
}

/** The login route renders without the application shell. Already-authenticated users visiting /login are redirected to their destination or the root route. */
const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  validateSearch: loginSearchSchema,
  beforeLoad: async ({ context, search }) => {
    const me = await context.queryClient.ensureQueryData(meQueryOptions()).catch(() => null);
    if (!me) return;
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw redirect({ href: safeRedirectPath(search.redirect) ?? "/" });
  },
  component: LoginPage,
});

/**
 * Warms the six shell queries asynchronously after session creation (07 §2),
 * allowing the sidebar and route skeleton to render without waiting for all
 * network requests. Individual query components handle failures.
 */
async function warmBootQueries(client: QueryClient): Promise<void> {
  const settings = await client.ensureQueryData(settingsQueryOptions()).catch(() => null);
  await Promise.all([
    client.prefetchQuery(runtimeConfigQueryOptions()),
    client.prefetchQuery(workspacesQueryOptions()),
  ]);
  const workspaces = client.getQueryData<{ id: string }[]>(queryKeys.workspaces());
  const workspaceId = settings?.defaultWorkspaceId ?? workspaces?.[0]?.id ?? null;
  if (workspaceId === null) return;
  await Promise.all([
    client.prefetchQuery(treesQueryOptions({ workspaceId })),
    client.prefetchQuery(foldersQueryOptions(workspaceId)),
    client.prefetchQuery(encyclopediaQueryOptions(workspaceId)),
  ]);
}

/** A pathless layout route, so every signed-in view shares one `AppShell`
 * instance — and therefore one keydown listener, one overlay stack and one
 * event subscription. */
const shellRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "_shell",
  beforeLoad: async ({ context, location }) => {
    // The kitchen sink is a design-system page with no server state; it is
    // reachable in development without an account (07 §3). The exemption is
    // conditioned on the build rather than on the path alone, so a route named
    // `/dev/...` in a production bundle could never opt out of the guard.
    if (isDevelopment && location.pathname.startsWith("/dev/")) return;
    const me = await context.queryClient.ensureQueryData(meQueryOptions()).catch(() => null);
    if (!me) {
      // The router's control-flow signal is a plain object, not an `Error`;
      // throwing it is how `beforeLoad` redirects.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw redirect({ to: "/login", search: { redirect: location.href } });
    }
  },
  loader: ({ context }) => {
    void warmBootQueries(context.queryClient);
  },
  component: AppShell,
  // Keep error and not-found views inside the shell so the sidebar, stage
  // header, and event subscription remain mounted when a route fails.
  errorComponent: RouteErrorPanel,
  notFoundComponent: RouteNotFoundPanel,
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

/** Catch-all route that renders the 404 panel within the shell so users retain access to navigation when requesting an invalid path. */
const notFoundRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/$",
  component: RouteNotFoundPanel,
});

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
    // Last: a catch-all would otherwise shadow the routes declared after it.
    notFoundRoute,
  ]),
]);

export interface AppRouterOptions extends Partial<Parameters<typeof createRouter>[0]> {
  queryClient?: QueryClient;
}

export function createAppRouter(
  options: AppRouterOptions = {},
): Router<typeof routeTree, "never", true> {
  const { queryClient = appQueryClient, ...rest } = options;
  return createRouter({
    routeTree,
    defaultPreload: "intent",
    context: { queryClient },
    // The shell's boundaries cover every signed-in view; these catch a failure
    // on `/login`, which renders outside the shell.
    defaultErrorComponent: RouteErrorPanel,
    defaultNotFoundComponent: RouteNotFoundPanel,
    ...rest,
  }) as Router<typeof routeTree, "never", true>;
}

export const router = createAppRouter();

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
