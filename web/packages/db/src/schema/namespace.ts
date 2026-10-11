// The whole Drizzle schema as one value.
//
// `@session/db` exposes it as `schema.nodes` rather than flattening thirty
// table names into the package root, where `nodes`, `trees`, and `users` would
// collide with the repository namespaces of the same names. A module because
// `import-x/no-unused-modules` follows a namespace import but not a namespace
// re-export, so this verifies the barrel's contents.

import * as schema from "./index.js";

export { schema };
