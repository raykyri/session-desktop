// The schema barrel drizzle-kit reads (`drizzle.config.ts`) and the value
// `openDatabase()` binds the Drizzle client to.
//
// The research tables are no longer declared here (plan `01` §2, A2). The
// migrations still create them until M8a squashes the migrations into one
// `0000_initial.sql` generated from this schema (`01` D5); nothing reads or
// writes them.

export * from "./apiKeys.js";
export * from "./backfills.js";
export * from "./preferences.js";
export * from "./sessions.js";
export * from "./usage.js";
export * from "./users.js";
