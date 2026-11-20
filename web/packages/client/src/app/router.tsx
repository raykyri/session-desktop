import type { QueryClient } from "@tanstack/react-query";
import {
  Outlet,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  lazyRouteComponent,
  notFound,
  redirect,
  type Router,
} from "@tanstack/react-router";
import { z } from "zod";

import { meQueryOptions } from "../api/account.js";
import { CHANNEL_NAME } from "../features/shell/screens.js";
import { viewerOf, type Viewer } from "../features/shell/viewer.js";
import { savePendingInvite } from "../lib/pendingInvite.js";
import { loadAdminRoute, loadSettingsRoute } from "../routes/chunks.js";
import { ChannelFeedPage, HomeFeedPage, SavedFeedPage } from "../routes/feeds.js";
import { LoginPage } from "../routes/login.js";
import {
  BrowsePage,
  InvitesPage,
  NotificationsPage,
  UsagePage,
  WelcomePage,
} from "../routes/pages.js";
import { claimLocalAccountState } from "../stores/localAccount.js";

import { RouteErrorPanel, RouteNotFoundPanel, RoutePendingPanel } from "./RouteBoundary.js";
import { AppShell } from "./layout/AppShell.js";
import { appQueryClient } from "./queryClient.js";

/** Thread and node ids are ULIDs (`AGENTS.md`, "Ids"). */
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** A field that is dropped, not refused, when malformed: a hand-edited or
 * truncated link still opens its feed. */
const optionalId = z
  .string()
  .regex(ULID)
  .optional()
  .catch(() => undefined);

/**
 * A feed's search (02 §2.1): `t` is the thread to scroll to and `sel` the
 * branch or reply to select in it, the address of a thread (decision P9).
 * Malformed values are dropped.
 */
export const feedSearchSchema = z.object({ t: optionalId, sel: optionalId });

export type FeedSearch = z.infer<typeof feedSearchSchema>;

/** Validates a feed's search. Both keys are always present, undefined when
 * absent or malformed: the router merges a route's search over its parent's
 * raw one, so a key left out would let the malformed value through. */
export function validateFeedSearch(search: Record<string, unknown>): FeedSearch {
  const parsed = feedSearchSchema.parse(search);
  return { t: parsed.t, sel: parsed.sel };
}

/** Search parameters for /login: the authentication error code (`error`),
 * where to return (`redirect`), and a sign-up code (`signup` or `invite`). */
const loginSearchSchema = z.object({
  error: z.string().optional(),
  signup: z.string().optional(),
  invite: z.string().optional(),
  redirect: z.string().optional(),
});

export type LoginSearch = z.infer<typeof loginSearchSchema>;

export interface RouterContext {
  queryClient: QueryClient;
}

const rootRoute = createRootRouteWithContext<RouterContext>()({ component: Outlet });

/** The UI development sandbox (`/dev/ui`, 08 §4) is registered only in
 * development and loaded lazily as a chunk excluded from production bundles.
 * Outside the bundler (tests) `import.meta.env` may be undefined. */
const isDevelopment = (import.meta as { env?: { DEV?: boolean } }).env?.DEV === true;

/**
 * Validates a post-login return path: same origin only, and never `/login`
 * itself. Mirrors the server's `safeReturnTo` (`auth/github.ts`).
 */
export function safeRedirectPath(value: string | undefined): string | null {
  if (value === undefined || !value.startsWith("/")) return null;
  if (value.startsWith("//") || value.startsWith("/\\")) return null;
  if (value === "/login" || value.startsWith("/login?")) return null;
  return value;
}

/**
 * Loads the session and binds this tab's local state to it
 * (`stores/localAccount.ts`). Answers the viewer; a failed request reads as
 * signed out.
 */
async function loadViewer(client: QueryClient): Promise<Viewer> {
  try {
    const me = await client.ensureQueryData(meQueryOptions());
    claimLocalAccountState(me?.id ?? null);
    return viewerOf(me);
  } catch {
    return viewerOf(null);
  }
}

function toLogin(href: string): never {
  // eslint-disable-next-line @typescript-eslint/only-throw-error
  throw redirect({ to: "/login", search: { redirect: href } });
}

/** Signed-in screens: a signed-out visitor signs in first. */
async function requireSignedIn({
  context,
  location,
}: {
  context: RouterContext;
  location: { href: string };
}): Promise<void> {
  const viewer = await loadViewer(context.queryClient);
  if (viewer.kind === "signedOut") toLogin(location.href);
}

/** Member screens (Invites, Usage): an account without an invite goes to
 * `/welcome` (02 W2.1). */
async function requireMember({
  context,
  location,
}: {
  context: RouterContext;
  location: { href: string };
}): Promise<void> {
  const viewer = await loadViewer(context.queryClient);
  if (viewer.kind === "signedOut") toLogin(location.href);
  if (viewer.kind === "waiting") {
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw redirect({ to: "/welcome", replace: true });
  }
}

/** The sign-in page renders without the shell. A signed-in visitor goes on to
 * where they were headed. */
const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  validateSearch: loginSearchSchema,
  beforeLoad: async ({ context, search }) => {
    const viewer = await loadViewer(context.queryClient);
    if (viewer.kind === "signedOut") return;
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw redirect({ href: safeRedirectPath(search.redirect) ?? "/" });
  },
  component: LoginPage,
});

/** The pathless layout route that keeps one `AppShell` (bar, scroll
 * container, toasts) mounted across every screen. */
const shellRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "_shell",
  beforeLoad: async ({ context, location }) => {
    // The development UI needs no session in development (07 §3).
    if (isDevelopment && location.pathname.startsWith("/dev/")) return;
    await loadViewer(context.queryClient);
  },
  component: AppShell,
  // Error and not-found views render inside the shell, so the bar stays.
  errorComponent: RouteErrorPanel,
  notFoundComponent: RouteNotFoundPanel,
});

/** Home: threads of joined channels (open channels, signed out). */
const homeRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/",
  validateSearch: validateFeedSearch,
  component: HomeFeedPage,
});

/** A channel's feed. A `#<code>` fragment is a channel invite link, taken
 * out of the URL before the router starts (`app/captureInvite.ts`). */
const channelRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/c/$name",
  validateSearch: validateFeedSearch,
  beforeLoad: ({ params }) => {
    if (!CHANNEL_NAME.test(params.name)) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw notFound();
    }
  },
  component: ChannelFeedPage,
});

const savedRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/saved",
  validateSearch: validateFeedSearch,
  beforeLoad: requireSignedIn,
  component: SavedFeedPage,
});

const browseRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/browse",
  component: BrowsePage,
});

const invitesRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/invites",
  beforeLoad: requireMember,
  component: InvitesPage,
});

const usageRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/usage",
  beforeLoad: requireMember,
  component: UsagePage,
});

/** Invite required: for signed-in accounts without an invite; a member goes
 * Home. */
const welcomeRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/welcome",
  beforeLoad: async ({ context, location }) => {
    const viewer = await loadViewer(context.queryClient);
    if (viewer.kind === "signedOut") toLogin(location.href);
    if (viewer.kind === "member") {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw redirect({ to: "/", replace: true });
    }
  },
  component: WelcomePage,
});

const notificationsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/notifications",
  beforeLoad: requireSignedIn,
  component: NotificationsPage,
});

const adminRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/admin",
  beforeLoad: requireSignedIn,
  component: lazyRouteComponent(loadAdminRoute, "AdminPage"),
  pendingComponent: RoutePendingPanel,
});

/**
 * An account invite link, `/i#<code>` (02 §2.1, 04 §3.2). A page load has
 * already moved the code into memory (`app/captureInvite.ts`); a navigation
 * inside the app carries it here in `location.hash`. Either way the code
 * stays out of the URL and the history. A signed-out visitor goes on to
 * sign in, which carries the code; the auth dialog of 02 W7.2 replaces that
 * step and opens over `/`.
 */
const inviteLinkRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/i",
  beforeLoad: async ({ context, location }) => {
    const code = location.hash.replace(/^#/, "").trim();
    if (code !== "") savePendingInvite({ kind: "account", code });
    const viewer = await loadViewer(context.queryClient);
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw redirect(
      viewer.kind === "signedOut" ? { to: "/login", search: {} } : { to: "/", replace: true },
    );
  },
});

/** Kept from the earlier client; not linked from the account menu (P23). */
const settingsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/settings",
  component: lazyRouteComponent(loadSettingsRoute, "SettingsPage"),
  pendingComponent: RoutePendingPanel,
});

/** Unknown paths render the not-found panel inside the shell. */
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
    channelRoute,
    savedRoute,
    browseRoute,
    invitesRoute,
    usageRoute,
    welcomeRoute,
    notificationsRoute,
    adminRoute,
    inviteLinkRoute,
    settingsRoute,
    ...devRoutes,
    // Last, so it shadows none of the paths above.
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
    // For routes outside the shell (`/login`).
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
