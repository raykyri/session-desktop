// `@session/replica-proto`: phase 0 of the sync core (AGENTS.md, "Sync
// core"), revised to the build's contract (`web/docs/15-implementation-plan/
// 01-architecture-and-data.md`, U6). A prototype of the server half's apply,
// snapshot and pull over a multi-user in-memory store, running the mutators
// of `@session/mutators` (plus the prototype's join requests), and a minimal
// replica client. Its tests are the adversarial suite that `@session/sync`'s
// server half must pass later. Nothing in the app imports this package.
//
// It re-exports `@session/mutators`, so the suite reads the records, rules
// and mutators from one place; `PROTO_MUTATORS` is the set its server runs:
// the package's `MUTATORS` with join requests.

export * from "@session/mutators";
export * from "./client.js";
export * from "./contract.js";
export { JOIN_REQUESTS, PROTO_MUTATORS } from "./join-requests.js";
export * from "./server.js";
export * from "./ulid.js";
