// The public surface of `@session/shared`. Every module in `src/` is
// re-exported here: `db`, `server`, and `client` import from the package root
// and never reach into a subpath, so this file is the whole contract between
// the packages.

/** Product name used in page titles, prompts, and user-facing copy. */
export const appName = "Session";

/**
 * Version of the shared domain contract. Bumped when wire shapes change so a
 * client and server built from different commits can be told apart.
 */
export const version = "0.0.0";

export * from "./app/composerTextarea.js";
export * from "./app/helpers.js";
export * from "./app/launcherKeyboard.js";
export * from "./app/shortcuts.js";
export * from "./app/sidebarMode.js";
export * from "./app/taggedInstructions.js";

export * from "./journal/activity.js";
export * from "./journal/cursor.js";
export * from "./journal/entries.js";
export * from "./journal/tweets.js";

export * from "./markdown/imageMarkers.js";
export * from "./markdown/links.js";
export * from "./markdown/mathDelimiters.js";
export * from "./markdown/plugins.js";
export * from "./markdown/turnTimeline.js";
export * from "./markdown/wikilinks.js";

export * from "./models/registry.js";

export * from "./research/branches.js";
export * from "./research/documents.js";
export * from "./research/events.js";
export * from "./research/folders.js";
export * from "./research/highlightAnchor.js";
export * from "./research/highlights.js";
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
export * from "./research/threads.js";

export * from "./types/account.js";
export * from "./types/activity.js";
export * from "./types/events.js";
export * from "./types/journal.js";
export * from "./types/research.js";
export * from "./types/turn.js";
export * from "./types/tweet.js";

export * from "./util/sha256.js";
export * from "./util/tokenEstimate.js";
