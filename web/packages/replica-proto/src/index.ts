// `@session/replica-proto`: phase 0 of the desktop client plan (AGENTS.md,
// "Planned: desktop client and sync core"). A prototype of the server half's
// apply, snapshot and pull over a multi-user in-memory store, the mutators
// ported from the mock backend, and a minimal replica client. Its tests are
// the adversarial suite that `@session/sync`'s server half must pass later.
// Nothing in the app imports this package.

export * from "./access.js";
export * from "./client.js";
export * from "./contract.js";
export {
  INVITE_MAX_DAYS,
  MESSAGES,
  RESERVED_HANDLES,
  Refusal,
  authorize,
  handleS,
  isHandle,
  mutatorNames,
  refuse,
  slug,
  type AnyMutator,
  type Effect,
  type MutatorDef,
  type NotifDraft,
  type PreCtx,
  type ServerValues,
  type Tx,
  type Who,
} from "./mutators.js";
export * from "./records.js";
export * from "./server.js";
export * from "./ulid.js";
// the active set (switch.ts): the prototype's own, or the package's
export { ACTIVE_MUTATORS as MUTATORS, USE_PACKAGE } from "./switch.js";
