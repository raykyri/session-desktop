// `@session/shared/wire`: the research wire model shared by the desktop and
// the web. Type declarations only; nothing here exists at runtime, so the
// desktop can import it without zod or any other package dependency. Zod
// schemas for these types are in `../schemas/`.

export type * from "./events.js";
export type * from "./research.js";
export type * from "./turn.js";
export type * from "./tweet.js";
