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
import { AccountPage, DevicePage, WelcomePage } from "../spaces/Account.js";
import { BrowsePage, CreateSpacePage, ProfilePage } from "../spaces/Directory.js";
import { HomePage } from "../spaces/HomePage.js";
import { InviteLanding } from "../spaces/InviteLanding.js";
import { ManagePage } from "../spaces/Manage.js";
import { NotificationsPage } from "../spaces/Notifications.js";
import { NotFound, Page } from "../spaces/Page.js";
import { PagePage } from "../spaces/PagesView.js";
import { SavedPage } from "../spaces/SavedPage.js";
import { SearchPage } from "../spaces/SearchPage.js";
import { SourcePage } from "../spaces/Sources.js";
import { SpacePage } from "../spaces/SpacePage.js";
import { ThreadPage } from "../spaces/ThreadPage.js";

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
    const { space, thread, node } = askRoute.useParams();
    return <ThreadPage spaceName={space} id={thread} node={node} />;
  },
});

const compareRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/s/$space/t/$thread/a/$node/compare/$pair",
  component: function CompareRoute() {
    const { space, thread, node, pair } = compareRoute.useParams();
    const [a = node, b = node] = pair.split(",");
    return <ThreadPage spaceName={space} id={thread} node={node} compare={[a, b]} />;
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

const pageRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/s/$space/pages/$slug",
  component: function PageRoute() {
    const { space, slug } = pageRoute.useParams();
    return <PagePage name={space} slug={slug} />;
  },
});

const aboutRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/s/$space/about",
  component: function AboutRoute() {
    const { space } = aboutRoute.useParams();
    return <SpacePage name={space} side="wiki" />;
  },
});

const sourceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/source/$id",
  component: function SourceRoute() {
    const { id } = sourceRoute.useParams();
    return <SourcePage id={id} />;
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

const profileRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/u/$handle",
  component: function ProfileRoute() {
    const { handle } = profileRoute.useParams();
    return <ProfilePage handle={handle} />;
  },
});
const browseRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/spaces/browse",
  component: BrowsePage,
});
const createSpaceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/spaces/new",
  beforeLoad: requireSignedIn,
  component: CreateSpacePage,
});
const yourSpacesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/spaces",
  beforeLoad: requireSignedIn,
  component: () => <AccountPage tab="spaces" />,
});
const accountRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/$tab",
  component: function AccountRoute() {
    const { tab } = accountRoute.useParams();
    return <AccountPage tab={tab} />;
  },
});
const deviceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/device",
  validateSearch: (s: Record<string, unknown>): { request?: string; code?: string } => ({
    ...(typeof s["request"] === "string" ? { request: s["request"] } : {}),
    ...(typeof s["code"] === "string" ? { code: s["code"] } : {}),
  }),
  component: function DeviceRoute() {
    const { request, code } = deviceRoute.useSearch();
    return <DevicePage {...(request ? { request } : {})} {...(code ? { code } : {})} />;
  },
});
const welcomeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/welcome",
  beforeLoad: requireSignedIn,
  component: WelcomePage,
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
  compareRoute,
  manageRoute,
  pageRoute,
  aboutRoute,
  inviteLinkRoute,
  sourceRoute,
  searchRoute,
  notificationsRoute,
  savedRoute,
  profileRoute,
  browseRoute,
  createSpaceRoute,
  yourSpacesRoute,
  accountRoute,
  deviceRoute,
  welcomeRoute,
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
