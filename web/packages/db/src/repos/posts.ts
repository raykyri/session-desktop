// Posts: notes and saved links the user writes, and the follow-up notes under
// them (the desktop's `create_research_post`, `create_research_post_follow_up`
// and `update_research_post`, `state.rs`). A post is a node with
// `type = 'post'` and no run; its text is `message_json` and `format` says
// whether it is one link.
//
// Admission is here; step 2.3 of the desktop-parity plan adds the edit
// (`updatePost`: stale-text and unchanged-text refusals, highlight
// re-anchoring, the derived root title) and tweet hydration.

import type { ResearchMessageAttachment, ResearchNode, ResearchTreeDetail } from "@session/shared";

import type { SessionDatabase } from "../connection.js";

import { admitChild } from "./nodes.js";
import type { NodeAgentInput } from "./trees.js";
import { admitRoot } from "./trees.js";

export interface AdmitPostInput {
  workspaceId: string;
  text: string;
  attachments?: ResearchMessageAttachment[] | undefined;
  /** The agent the post's AI follow-ups default to. */
  agent: NodeAgentInput;
}

/** Creates a thread whose root is a post. Its format is derived from the
 * text. */
export function admitPost(
  db: SessionDatabase,
  userId: string,
  input: AdmitPostInput,
): ResearchTreeDetail {
  return admitRoot(db, userId, {
    workspaceId: input.workspaceId,
    type: "post",
    message: {
      text: input.text,
      ...(input.attachments && input.attachments.length > 0
        ? { attachments: input.attachments }
        : {}),
    },
    agent: input.agent,
  });
}

/** Adds a follow-up note under a post. */
export function admitFollowUpNote(
  db: SessionDatabase,
  userId: string,
  parentNodeId: string,
  text: string,
): ResearchNode {
  return admitChild(db, userId, { parentNodeId, type: "post", message: { text } });
}
