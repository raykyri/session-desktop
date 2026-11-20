// `@session/shared/schemas`: zod schemas for the wire types in `../wire/`.
// Server-side validation imports these; the desktop does not, so it never
// bundles zod.

export * from "./events.js";
export * from "./research.js";
export * from "./turn.js";
export * from "./tweet.js";

// The spaces contract (records, mutators, errors) is reached through a
// namespace: `spaces.threadRecordSchema`. The first-draft mock's contract,
// `./spaces.deferred.ts`, is not exported.
export * as spaces from "./spaces.js";
