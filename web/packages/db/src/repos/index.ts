// The repository surface. Each module becomes one namespace so call sites read
// as `trees.admitRoot(db, userId, …)` — the noun is the table, the verb is the
// invariant — and so two repositories may both have a `remove` without
// colliding here.
//
// Imported and then re-exported rather than `export * as`: the two are
// equivalent at runtime, but `import-x/no-unused-modules` only follows the
// namespace import, so this spelling is what keeps a module that nothing uses
// visible as an error rather than silently retained.

import * as artifacts from "./artifacts.js";
import * as auth from "./auth.js";
import * as documents from "./documents.js";
import * as drafts from "./drafts.js";
import * as encyclopedia from "./encyclopedia.js";
import * as feedItems from "./feedItems.js";
import * as feedgen from "./feedgen.js";
import * as feeds from "./feeds.js";
import * as folders from "./folders.js";
import * as highlights from "./highlights.js";
import * as journal from "./journal.js";
import * as mappers from "./mappers.js";
import * as messages from "./messages.js";
import * as nodes from "./nodes.js";
import * as preferences from "./preferences.js";
import * as queue from "./queue.js";
import * as recaps from "./recaps.js";
import * as researchDocuments from "./researchDocuments.js";
import * as runs from "./runs.js";
import * as snapshots from "./snapshots.js";
import * as subtrees from "./subtrees.js";
import * as trees from "./trees.js";
import * as tweets from "./tweets.js";
import * as usage from "./usage.js";
import * as users from "./users.js";
import * as workspaces from "./workspaces.js";

export {
  artifacts,
  auth,
  documents,
  drafts,
  encyclopedia,
  feedgen,
  feedItems,
  feeds,
  folders,
  highlights,
  journal,
  mappers,
  messages,
  nodes,
  preferences,
  queue,
  recaps,
  researchDocuments,
  runs,
  snapshots,
  subtrees,
  trees,
  tweets,
  usage,
  users,
  workspaces,
};
