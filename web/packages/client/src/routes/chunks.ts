// The route modules loaded on demand (`07-client-architecture.md` §3). Each
// importer is the boundary of a chunk: the router's `lazyRouteComponent`
// calls it when the route is matched or preloaded, and a feed card calls
// `preloadThreadRoute` on hover and focus so the thread page's chunk is in
// before the click. Home, the place views (which are Home's feed on another
// place), the login page and the invitation page stay in the main chunk:
// they are what a first load shows.

export const loadThreadRoute = () => import("./research.$treeId.js");
export const loadHighlightsRoute = () => import("./highlights.js");
export const loadNotificationsRoute = () => import("./notifications.js");
export const loadSettingsRoute = () => import("./settings.js");
export const loadAdminRoute = () => import("./admin.js");

/** Starts loading the thread page's chunk. A failure is left to the
 * navigation, which shows the route's error panel. */
export function preloadThreadRoute(): void {
  loadThreadRoute().catch(() => undefined);
}
