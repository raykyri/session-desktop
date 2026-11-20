// The route modules loaded on demand (`07-client-architecture.md` §3). Each
// importer is the boundary of a chunk: the router's `lazyRouteComponent`
// calls it when the route is matched or preloaded. The feeds, the pages of
// 02 §2.1 and the login page stay in the main chunk: they are what a first
// load shows.

export const loadSettingsRoute = () => import("./settings.js");
export const loadAdminRoute = () => import("./admin.js");
