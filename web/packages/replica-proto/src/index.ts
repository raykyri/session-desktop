// `@session/replica-proto`: phase 0 of the sync core (AGENTS.md, "Sync
// core"), revised to the build's contract (`web/docs/15-implementation-plan/
// 01-architecture-and-data.md`, U6). A prototype of the server half's apply,
// snapshot and pull over a multi-user in-memory store, the mutators ported
// from the mock backend, and a minimal replica client. Its tests are the
// adversarial suite that `@session/sync`'s server half must pass later.
// Nothing in the app imports this package.

export * from "./access.js";
export * from "./client.js";
export * from "./contract.js";
export * from "./mutators.js";
export * from "./records.js";
export * from "./server.js";
export * from "./ulid.js";
