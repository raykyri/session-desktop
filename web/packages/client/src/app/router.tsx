// The web client's routes (phase 2a: the shell phase 2b builds the spaces
// client in): sign-in, a sign-up invite, settings, the admin pages and a
// placeholder Home. Spaces are not served here yet.

import type { QueryClient } from "@tanstack/react-query";
import {
  Outlet,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  lazyRouteComponent,
  redirect,
  type RouterHistory,
  type Router,
} from "@tanstack/react-router";
import { z } from "zod";

import { meQueryOptions } from "../api/account.js";
import { loadAdminRoute, loadSettingsRoute } from "../routes/chunks.js";
import { HomePage } from "../routes/home.js";
import { InvitePage } from "../routes/invite.js";
import { LoginPage } from "../routes/login.js";

import { RouteErrorPanel, RouteNotFoundPanel, RoutePendingPanel } from "./RouteBoundary.js";
import { AppShell } from "./layout/AppShell.js";
import { appQueryClient } from "./queryClient.js";

interface RouterContext {
  queryClient: QueryClient;
}

/** /login: an error code from the OAuth callback, where to go after, and a
 * sign-up code. */
const loginSearchSchema = z.object({
  error: z.string().optional(),
  signup: z.string().optional(),
  redirect: z.string().optional(),
});

/** /invite: a sign-up code. */
const inviteSearchSchema = z.object({ code: z.string().optional() });

const rootRoute = createRootRouteWithContext<RouterContext>()({ component: Outlet });

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  validateSearch: loginSearchSchema,
  beforeLoad: async ({ context, search }) => {
    const me = await context.queryClient.ensureQueryData(meQueryOptions()).catch(() => null);
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    if (me) throw redirect({ to: search.redirect?.startsWith("/") ? search.redirect : "/" });
  },
  component: LoginPage,
});

const shellRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "shell",
  component: AppShell,
});

const requireSignedIn = async ({
  context,
  location,
}: {
  context: RouterContext;
  location: { href: string };
}) => {
  const me = await context.queryClient.ensureQueryData(meQueryOptions()).catch(() => null);
  // eslint-disable-next-line @typescript-eslint/only-throw-error
  if (!me) throw redirect({ to: "/login", search: { redirect: location.href } });
};

const homeRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/",
  component: HomePage,
});

const inviteRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/invite",
  validateSearch: inviteSearchSchema,
  component: InvitePage,
});

const settingsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/settings",
  beforeLoad: requireSignedIn,
  component: lazyRouteComponent(loadSettingsRoute, "SettingsPage"),
});

const adminRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/admin",
  beforeLoad: requireSignedIn,
  component: lazyRouteComponent(loadAdminRoute, "AdminPage"),
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  shellRoute.addChildren([homeRoute, inviteRoute, settingsRoute, adminRoute]),
]);

export function createAppRouter(options: { queryClient: QueryClient; history?: RouterHistory }) {
  return createRouter({
    routeTree,
    context: { queryClient: options.queryClient },
    ...(options.history ? { history: options.history } : {}),
    defaultPendingComponent: RoutePendingPanel,
    defaultErrorComponent: RouteErrorPanel,
    defaultNotFoundComponent: RouteNotFoundPanel,
  });
}

export const router: Router<typeof routeTree> = createAppRouter({ queryClient: appQueryClient });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
