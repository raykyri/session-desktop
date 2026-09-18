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
import { LoginPage } from "../routes/login.js";
import {
  BookmarksPage,
  EncyclopediaPage,
  HighlightsPage,
  HomePage,
  ResearchPage,
} from "../routes/placeholders.js";
import { SettingsPage } from "../routes/settings.js";

import { AppShell } from "./layout/AppShell.js";
import { appQueryClient } from "./queryClient.js";

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

/** What the server puts on `/login` when a sign-in attempt is refused
 * (`server/src/auth/github.ts:signInError`), plus the path the guard wants to
 * return to and an invite code a user was sent. */
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
 * Where the guard may send a tab back to. Only a rooted path of this app
 * qualifies: `//host` is another origin to the browser, and `/login` itself
 * would be a loop. The server applies the same rule to `return_to`
 * (`auth/github.ts:safeReturnTo`); this one governs the in-app hop, which
 * never reaches the server.
 */
export function safeRedirectPath(value: string | undefined): string | null {
  if (value === undefined || !value.startsWith("/")) return null;
  if (value.startsWith("//") || value.startsWith("/\\")) return null;
  if (value === "/login" || value.startsWith("/login?")) return null;
  return value;
}

/** Sign-in renders outside the shell: there is no sidebar, no stage header and
 * no subscription before a session exists. A tab that already has one has
 * nothing to do here — a bookmark, or Back after signing in — so it goes on to
 * whatever it was asking for. */
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
 * The six queries the shell renders from, warmed in parallel once a session
 * exists (07 §2). Fire-and-forget: the first paint is the sidebar frame and
 * the route's own skeleton, and blocking it on six round trips would trade a
 * fast empty shell for a slow blank page. Failures land on the queries
 * themselves, which is where a view shows them.
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
    ...rest,
  }) as Router<typeof routeTree, "never", true>;
}

export const router = createAppRouter();

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
