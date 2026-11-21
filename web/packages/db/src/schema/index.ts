// The schema barrel drizzle-kit reads (`drizzle.config.ts`) and the value
// `openDatabase()` binds the Drizzle client to.
//
// `migrations/0000_initial.sql` is generated from this barrel (plan `01`
// D5, the M8a squash). The research tables were deleted in M4 (`01` A2) and
// no migration creates them.

export * from "./apiKeys.js";
export * from "./backfills.js";
export * from "./preferences.js";
export * from "./sessions.js";
export * from "./sync.js";
export * from "./usage.js";
export * from "./users.js";
