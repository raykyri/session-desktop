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
  foldersQueryOptions,
  meQueryOptions,
  runtimeConfigQueryOptions,
  settingsQueryOptions,
  treesQueryOptions,
  workspacesQueryOptions,
} from "../api/queries.js";
import { ThreadPending } from "../features/thread/ThreadPending.js";
import { savePendingInvite } from "../lib/pendingInvite.js";
import {
  loadAdminRoute,
  loadHighlightsRoute,
  loadNotificationsRoute,
  loadSettingsRoute,
  loadThreadRoute,
} from "../routes/chunks.js";
import { HomePage } from "../routes/home.js";
import { InvitePage } from "../routes/invite.js";
import { LoginPage } from "../routes/login.js";
import {
  ArchivePage,
  DraftPage,
  DraftsPage,
  FolderPage,
  SharedPage,
  TrashPage,
} from "../routes/places.js";
import { claimLocalAccountState } from "../stores/localAccount.js";

import { RouteErrorPanel, RouteNotFoundPanel, RoutePendingPanel } from "./RouteBoundary.js";
import { AppShell } from "./layout/AppShell.js";
import { appQueryClient } from "./queryClient.js";

// View state is kept in URL query parameters rather than localStorage so deep
// links and multiple tabs remain synchronized; each schema below validates and
// rejects malformed values.
const workspaceScopeSearchSchema = z.object({
  /** Workspace scope. Absent means the account's default workspace. */
  ws: z.string().optional(),
  /** Home's feed: All Users (`all`), My Workspaces (`workspaces`), or the
   * workspace's own Home (its id). */
  feed: z.string().optional(),
});

const researchSearchSchema = z.object({
  /** Workspace scope, carried across every route so the sidebar keeps showing
   * the workspace the thread was opened from. */
  ws: z.string().optional(),
  /** Each column's selected message, root column first, comma-separated
   * (`features/thread/useThreadHistory.ts`). */
  sel: z.string().optional(),
  /** A message to open: its source path replaces it with `sel`. */
  node: z.string().optional(),
  /** A highlight to scroll to and focus once the document loads. */
  highlight: z.string().optional(),
  /** Node id of a note to open in the editor. */
  edit: z.string().optional(),
  filter: z.enum(["active", "archived", "all"]).optional(),
  feed: z.string().optional(),
});

/** Search parameters for /login: authentication error code (`error`), post-login
 * destination (`redirect`), and registration invite token (`signup` or legacy `invite`). */
const loginSearchSchema = z.object({
  error: z.string().optional(),
  signup: z.string().optional(),
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

/** The UI development sandbox (`/dev/ui`, 08 §4) is registered only in development
 * and loaded lazily as a chunk excluded from production bundles. Outside the bundler
 * (such as test environments), `import.meta.env` may be undefined, so the check
 * handles its absence. */
const isDevelopment = (import.meta as { env?: { DEV?: boolean } }).env?.DEV === true;

/**
 * Validates post-login return paths to enforce same-origin redirects and prevent
 * redirect loops to /login. Mirrors server-side `safeReturnTo` validation (`auth/github.ts`).
 */
export function safeRedirectPath(value: string | undefined): string | null {
  if (value === undefined || !value.startsWith("/")) return null;
  if (value.startsWith("//") || value.startsWith("/\\")) return null;
  if (value === "/login" || value.startsWith("/login?")) return null;
  return value;
}

/**
 * Loads the current authentication session. Associates local unsent drafts and
 * thread state with the authenticated account (`stores/localAccount.ts`); returns
 * null if unauthenticated or on request failure.
 */
async function loadSession(client: QueryClient) {
  try {
    const me = await client.ensureQueryData(meQueryOptions());
    claimLocalAccountState(me?.id ?? null);
    return me;
  } catch {
    return null;
  }
}

/** The login route renders without the application shell. Already-authenticated users visiting /login are redirected to their destination or the root route. */
const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  validateSearch: loginSearchSchema,
  beforeLoad: async ({ context, search }) => {
    const me = await loadSession(context.queryClient);
    if (!me) return;
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw redirect({ href: safeRedirectPath(search.redirect) ?? "/" });
  },
  component: LoginPage,
});

/**
 * Prefetches core application shell queries required for sidebar rendering (07 §2).
 * Loads user settings if authenticated; prefetches runtime configuration and workspaces.
 */
async function warmBootQueries(client: QueryClient): Promise<void> {
  const me = await client.ensureQueryData(meQueryOptions()).catch(() => null);
  const settings = me
    ? await client.ensureQueryData(settingsQueryOptions()).catch(() => null)
    : null;
  await Promise.all([
    client.prefetchQuery(runtimeConfigQueryOptions()),
    client.prefetchQuery(workspacesQueryOptions()),
  ]);
  const workspaces = client.getQueryData<{ id: string }[]>(queryKeys.workspaces());
  const workspaceId = settings?.defaultWorkspaceId ?? workspaces?.[0]?.id ?? null;
  if (workspaceId === null) return;
  await Promise.all([
    client.prefetchQuery(treesQueryOptions({ workspaceId, includeArchived: true })),
    client.prefetchQuery(foldersQueryOptions(workspaceId)),
  ]);
}

/** Pathless layout route providing a shared `AppShell` instance across all routes
 * for unified event listeners, overlay management, and event subscriptions. */
const shellRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "_shell",
  beforeLoad: async ({ context, location }) => {
    // The development UI route requires no authentication in development mode (07 §3).
    // The exemption is conditioned on the build environment rather than path alone,
    // preventing production routes from bypassing authentication based solely on path prefix.
    if (isDevelopment && location.pathname.startsWith("/dev/")) return;
    await loadSession(context.queryClient);
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

async function requireSignedIn({
  context,
  location,
}: {
  context: RouterContext;
  location: { href: string };
}): Promise<void> {
  const me = await loadSession(context.queryClient);
  if (!me) {
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw redirect({ to: "/login", search: { redirect: location.href } });
  }
}

const highlightsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/highlights",
  validateSearch: workspaceScopeSearchSchema,
  beforeLoad: requireSignedIn,
  component: lazyRouteComponent(loadHighlightsRoute, "HighlightsPage"),
  pendingComponent: RoutePendingPanel,
});

/** Folder and filtered collection routes (`10-home-feed-journal.md` §1). */
const folderRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/f/$folderId",
  validateSearch: workspaceScopeSearchSchema,
  beforeLoad: requireSignedIn,
  component: FolderPage,
});

const draftsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/drafts",
  validateSearch: workspaceScopeSearchSchema,
  beforeLoad: requireSignedIn,
  component: DraftsPage,
});

const draftRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/drafts/$draftId",
  validateSearch: workspaceScopeSearchSchema,
  beforeLoad: requireSignedIn,
  component: DraftPage,
});

const archiveRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/archive",
  validateSearch: workspaceScopeSearchSchema,
  beforeLoad: requireSignedIn,
  component: ArchivePage,
});

const trashRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/trash",
  validateSearch: workspaceScopeSearchSchema,
  beforeLoad: requireSignedIn,
  component: TrashPage,
});

/** Web only: threads shared with the current user. */
const sharedRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/shared",
  validateSearch: workspaceScopeSearchSchema,
  beforeLoad: requireSignedIn,
  component: SharedPage,
});

/** Web only: notification inbox route. */
const notificationsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/notifications",
  validateSearch: workspaceScopeSearchSchema,
  beforeLoad: requireSignedIn,
  component: lazyRouteComponent(loadNotificationsRoute, "NotificationsPage"),
  pendingComponent: RoutePendingPanel,
});

/** Invitation acceptance route (`/invite#<token>`). Unauthenticated visitors
 * are redirected to sign in with the pending token stored in `sessionStorage`
 * (`lib/pendingInvite.ts`). */
const inviteRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/invite",
  component: InvitePage,
});

/** Legacy invitation route redirecting path-parameter tokens (`/invite/$token`)
 * to the fragment-based invitation handler. */
const legacyInviteRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/invite/$token",
  beforeLoad: ({ params }) => {
    savePendingInvite(params.token);
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw redirect({ to: "/invite", replace: true });
  },
});

const researchRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/r/$treeId",
  validateSearch: researchSearchSchema,
  component: lazyRouteComponent(loadThreadRoute, "ThreadPage"),
  // Displays thread header placeholder while the lazy route chunk loads.
  pendingComponent: ThreadPending,
});

const settingsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/settings",
  validateSearch: workspaceScopeSearchSchema,
  component: lazyRouteComponent(loadSettingsRoute, "SettingsPage"),
  pendingComponent: RoutePendingPanel,
});

const adminRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/admin",
  validateSearch: workspaceScopeSearchSchema,
  beforeLoad: requireSignedIn,
  component: lazyRouteComponent(loadAdminRoute, "AdminPage"),
  pendingComponent: RoutePendingPanel,
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
    highlightsRoute,
    folderRoute,
    draftsRoute,
    draftRoute,
    archiveRoute,
    trashRoute,
    sharedRoute,
    notificationsRoute,
    inviteRoute,
    legacyInviteRoute,
    researchRoute,
    settingsRoute,
    adminRoute,
    ...devRoutes,
    // Catch-all route placed last to avoid shadowing preceding route paths.
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
    // Default error and not-found components for routes rendered outside the
    // shell boundary (such as `/login`).
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
