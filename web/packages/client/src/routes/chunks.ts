// The route modules loaded on demand (`07-client-architecture.md` §3): the
// router's `lazyRouteComponent` calls each importer when its route is matched.

export const loadSettingsRoute = () => import("./settings.js");
export const loadAdminRoute = () => import("./admin.js");
