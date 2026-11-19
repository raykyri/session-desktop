// The repository surface. Each module becomes one namespace so call sites read
// as `runs.enqueue(db, …)` and two repositories may both have a `remove`
// without colliding here.
//
// Imported and then re-exported rather than `export * as`: the two are
// equivalent at runtime, but `import-x/no-unused-modules` only follows the
// namespace import, so this spelling keeps a module that nothing uses visible
// as an error.

import * as apiKeys from "./apiKeys.js";
import * as auth from "./auth.js";
import * as preferences from "./preferences.js";
import * as runs from "./runs.js";
import * as uploads from "./uploads.js";
import * as usage from "./usage.js";
import * as users from "./users.js";

export { apiKeys, auth, preferences, runs, uploads, usage, users };
