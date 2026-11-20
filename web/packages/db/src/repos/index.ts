// The repository surface. Each module becomes one namespace so call sites read
// as `users.findById(db, …)` — the noun is the table, the verb is the
// invariant — and so two repositories may both have a `remove` without
// colliding here.
//
// Imported and then re-exported rather than `export * as`: the two are
// equivalent at runtime, but `import-x/no-unused-modules` only follows the
// namespace import, so this spelling is what keeps a module that nothing uses
// visible as an error rather than silently retained.

import * as auth from "./auth.js";
import * as preferences from "./preferences.js";
import * as usage from "./usage.js";
import * as users from "./users.js";

export { auth, preferences, usage, users };
