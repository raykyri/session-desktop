// The root surface of `@session/shared`: `db`, `server`, and `client` import
// the research wire model, its zod schemas, and the web's own types and logic
// from here. The package also exports subpaths that the desktop imports too,
// through the `@session/shared/*` alias in the repository root's
// tsconfig.json and vite.config.ts:
//
// - `@session/shared/wire`: the research wire model as plain types,
//   re-exported here.
// - `@session/shared/schemas`: zod schemas for the wire model, re-exported
//   here.
// - `@session/shared/lib/<module>`: research logic on the wire model, moved
//   from the desktop's `src/lib`. The web imports these by subpath; they are
//   not re-exported here, so a lib module and a web module may share a name.

/** Product name used in page titles, prompts, and user-facing copy. */
export const appName = "Session";

/**
 * Version of the shared domain contract. Bumped when wire shapes change so a
 * client and server built from different commits can be told apart.
 */
export const version = "0.0.0";

export type * from "./wire/index.js";
export * from "./schemas/index.js";

export * from "./app/composerTextarea.js";
export * from "./app/helpers.js";
export * from "./app/launcherKeyboard.js";
export * from "./app/shortcuts.js";
export * from "./app/sidebarMode.js";
export * from "./app/taggedInstructions.js";

export * from "./journal/activity.js";
export * from "./journal/cursor.js";
export * from "./journal/tweets.js";

export * from "./markdown/imageMarkers.js";
export * from "./markdown/links.js";
export * from "./markdown/mathDelimiters.js";
export * from "./markdown/plugins.js";
export * from "./markdown/turnTimeline.js";
export * from "./markdown/wikilinks.js";

export * from "./models/agents.js";
export * from "./models/registry.js";

export * from "./research/events.js";
export * from "./research/folders.js";
export * from "./research/highlightAnchor.js";
export * from "./research/history.js";
export * from "./research/navigation.js";
export * from "./research/order.js";
export * from "./research/preview.js";
export * from "./research/prompts.js";
export * from "./research/recap.js";
export * from "./research/revision.js";
export * from "./research/scope.js";
export * from "./research/selection.js";
export * from "./research/snapshots.js";

export * from "./types/account.js";
export * from "./types/activity.js";

export * from "./util/sha256.js";
export * from "./util/tokenEstimate.js";

export * from "./markdown/sessionWidgets.js";
export * from "./markdown/widgetProjection.js";
