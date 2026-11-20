// The web client's routes (phase 2b): the spaces client at the mockup's
// addresses (Home, `/s/<space>`, `/s/<space>/t/<thread>`, Search,
// Notifications, Saved), and the shell's pages from phase 2a (sign-in, a
// sign-up invite, settings, admin) under the older shell.

import {
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  redirect,
  type RouterHistory,
  type Router,
} from "@tanstack/react-router";
import { z } from "zod";

import { ensureMe } from "../api/account.js";
import { loadAdminRoute, loadSettingsRoute } from "../routes/chunks.js";
import { InvitePage } from "../routes/invite.js";
import { LoginPage } from "../routes/login.js";
import { HomePage } from "../spaces/HomePage.js";
import { InviteLanding } from "../spaces/InviteLanding.js";
import { ManagePage } from "../spaces/Manage.js";
import { NotificationsPage } from "../spaces/Notifications.js";
import { NotFound, Page } from "../spaces/Page.js";
import { SavedPage } from "../spaces/SavedPage.js";
import { SearchPage } from "../spaces/SearchPage.js";
import { SpacePage } from "../spaces/SpacePage.js";
import { ThreadPage } from "../spaces/ThreadPage.js";
import { BackRow } from "../spaces/nav.js";

import { RouteErrorPanel, RoutePendingPanel } from "./RouteBoundary.js";
import { SpacesRoot } from "./SpacesRoot.js";
import { AppShell } from "./layout/AppShell.js";

/** /login: an error code from the OAuth callback, where to go after, and a
 * sign-up code. */
const loginSearchSchema = z.object({
  error: z.string().optional(),
  signup: z.string().optional(),
  redirect: z.string().optional(),
});

/** /invite: a sign-up code. */
const inviteSearchSchema = z.object({ code: z.string().optional() });

const searchSchema = z.object({ q: z.string().optional(), in: z.string().optional() });

function NotFoundPage() {
  return (
    <Page place={{ kind: "other" }}>
      <NotFound />
    </Page>
  );
}

const rootRoute = createRootRoute({ component: SpacesRoot, notFoundComponent: NotFoundPage });

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  validateSearch: loginSearchSchema,
  beforeLoad: async ({ search }) => {
    const me = await ensureMe();
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    if (me) throw redirect({ to: search.redirect?.startsWith("/") ? search.redirect : "/" });
  },
  component: LoginPage,
});

const requireSignedIn = async ({ location }: { location: { href: string } }) => {
  const me = await ensureMe();
  // eslint-disable-next-line @typescript-eslint/only-throw-error
  if (!me) throw redirect({ to: "/login", search: { redirect: location.href } });
};

// ---- the spaces client ----

const homeRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: HomePage });

const spaceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/s/$space",
  component: function SpaceRoute() {
    const { space } = spaceRoute.useParams();
    return <SpacePage name={space} />;
  },
});

const latestRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/s/$space/latest",
  component: function LatestRoute() {
    const { space } = latestRoute.useParams();
    return <SpacePage name={space} view={{ kind: "latest" }} />;
  },
});

const topicRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/s/$space/topics/$topic",
  component: function TopicRoute() {
    const { space, topic } = topicRoute.useParams();
    return <SpacePage name={space} view={{ kind: "topic", topic }} />;
  },
});

const threadRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/s/$space/t/$thread",
  component: function ThreadRoute() {
    const { space, thread } = threadRoute.useParams();
    return <ThreadPage spaceName={space} id={thread} />;
  },
});

const askRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/s/$space/t/$thread/a/$node",
  component: function AskRoute() {
    const { space, thread } = askRoute.useParams();
    return <ThreadPage spaceName={space} id={thread} />;
  },
});

const manageRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/s/$space/manage/$tab",
  component: function ManageRoute() {
    const { space, tab } = manageRoute.useParams();
    return <ManagePage name={space} tab={tab} />;
  },
});

const inviteLinkRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/i/$code",
  component: function InviteLinkRoute() {
    const { code } = inviteLinkRoute.useParams();
    return <InviteLanding code={code} />;
  },
});

const searchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/search",
  validateSearch: searchSchema,
  component: function SearchRoute() {
    const s = searchRoute.useSearch();
    return <SearchPage q={s.q ?? ""} scope={s.in} />;
  },
});

const notificationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/notifications",
  beforeLoad: requireSignedIn,
  component: function NotificationsRoute() {
    return (
      <Page place={{ kind: "notifications" }}>
        <NotificationsPage />
      </Page>
    );
  },
});

const savedRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/saved",
  beforeLoad: requireSignedIn,
  component: SavedPage,
});

/** A screen the later slices of phase 2b build: its title under the header. */
function Later({ title }: { title: string }) {
  return (
    <Page place={{ kind: "other", label: title }}>
      <div className="home-wide sub-page">
        <BackRow />
        <div className="sub-top">
          <h2>{title}</h2>
        </div>
      </div>
    </Page>
  );
}

const profileRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/u/$handle",
  component: function ProfileRoute() {
    const { handle } = profileRoute.useParams();
    return <Later title={handle} />;
  },
});
const browseRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/spaces/browse",
  component: () => <Later title="Browse spaces" />,
});
const createSpaceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/spaces/new",
  beforeLoad: requireSignedIn,
  component: () => <Later title="Create a space" />,
});
const yourSpacesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/spaces",
  beforeLoad: requireSignedIn,
  component: () => <Later title="Your spaces" />,
});
const keysRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/keys",
  beforeLoad: requireSignedIn,
  component: () => <Later title="API keys" />,
});

// ---- the shell's pages (phase 2a) ----

const shellRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "shell",
  component: AppShell,
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
  homeRoute,
  spaceRoute,
  latestRoute,
  topicRoute,
  threadRoute,
  askRoute,
  manageRoute,
  inviteLinkRoute,
  searchRoute,
  notificationsRoute,
  savedRoute,
  profileRoute,
  browseRoute,
  createSpaceRoute,
  yourSpacesRoute,
  keysRoute,
  shellRoute.addChildren([inviteRoute, settingsRoute, adminRoute]),
]);

export function createAppRouter(options: { history?: RouterHistory } = {}) {
  return createRouter({
    routeTree,
    ...(options.history ? { history: options.history } : {}),
    defaultPendingComponent: RoutePendingPanel,
    defaultErrorComponent: RouteErrorPanel,
    defaultNotFoundComponent: NotFoundPage,
  });
}

export const router: Router<typeof routeTree> = createAppRouter();

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

export { Outlet };
