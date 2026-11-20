// The `/r/$treeId` route entry (`07-client-architecture.md` §3).
//
// The component itself is the thread feature; this module exists so the
// router imports a route file rather than reaching into `features/`.

export { ThreadPage } from "../features/thread/ThreadPage.js";
