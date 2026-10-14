// The `research` router: threads, nodes, and their content
// (`03-api-and-events.md` §2). Each file contributes one group of procedures
// under the one `research.*` namespace, so steps that add procedures edit
// separate files:
//
// - `trees.ts`: listing, ordering, creating, archiving and deleting threads;
// - `nodes.ts`: follow-ups, retry, cancel, content and document edits;
// - `posts.ts`: notes and saved links;
// - `trash.ts`: the Trash.
//
// `followups.ts` is mounted as its own `followups` router in `trpc/router.ts`.

import { router } from "../../base.js";

import { nodeProcedures } from "./nodes.js";
import { postProcedures } from "./posts.js";
import { trashProcedures } from "./trash.js";
import { treeProcedures } from "./trees.js";

export const researchRouter = router({
  ...treeProcedures,
  ...nodeProcedures,
  ...postProcedures,
  ...trashProcedures,
});

export { followupProcedures } from "./followups.js";
