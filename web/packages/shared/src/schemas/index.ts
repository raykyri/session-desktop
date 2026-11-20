// `@session/shared/schemas`: zod schemas for the wire types in `../wire/`.
// Server-side validation imports these; the desktop does not, so it never
// bundles zod.

export * from "./events.js";
export * from "./research.js";
export * from "./turn.js";
export * from "./tweet.js";

// The Spaces API's schemas (the HTML mockup's contract) are named after the
// real wire types they stand in for, which are other shapes, so they are
// reached through a namespace: `spaces.researchTreeSummarySchema`.
export * as spaces from "./spaces.js";
