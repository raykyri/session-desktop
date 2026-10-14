// Posts: notes and saved links the user writes, and the follow-up notes under
// them (the desktop's `create_research_post`, `create_research_post_follow_up`
// and `update_research_post`, `state.rs`). A post is a node with
// `type = 'post'` and no run; its text is `message_json` and `format` says
// whether it is one link.

import type {
  ResearchMessageAttachment,
  ResearchNode,
  ResearchTree,
  ResearchTreeDetail,
  UserMessage,
} from "@session/shared";
import {
  MAX_POST_TEXT_BYTES,
  postDefaultTitle,
  postTextBytes,
  userMessageSchema,
} from "@session/shared";
import { reanchorResearchQuote } from "@session/shared/lib/researchAnchors";
import { postFormatOf } from "@session/shared/lib/researchNodeTypes";
import { and, eq } from "drizzle-orm";

import type { SessionDatabase } from "../connection.js";
import { transact } from "../connection.js";
import { parseWireColumn } from "../json.js";
import { highlights } from "../schema/highlights.js";
import { nodes } from "../schema/nodes.js";
import { trees } from "../schema/trees.js";
import { now, strictlyAfter } from "../time.js";

import { nodeOwnedBy, rejectTrashed, rejectTrashedNode } from "./access.js";
import { imageIdsOf, markAttached } from "./images.js";
import { toResearchHighlight } from "./mappers.js";
import type { NodeRow, TreeRow } from "./mappers.js";
import { admitChild, get as getNode } from "./nodes.js";
import type { NodeAgentInput } from "./trees.js";
import { admitRoot, treeFor } from "./trees.js";

/** The trimmed text of a note, refused when empty or over the limit. */
function noteText(text: string, empty: string): string {
  const trimmed = text.trim();
  if (trimmed === "") {
    throw new Error(empty);
  }
  if (postTextBytes(trimmed) > MAX_POST_TEXT_BYTES) {
    throw new Error(`notes are limited to ${MAX_POST_TEXT_BYTES} bytes`);
  }
  return trimmed;
}

export interface AdmitPostInput {
  workspaceId: string;
  text: string;
  /** The X posts the text links to and the images it carries, resolved by
   * the caller. */
  attachments?: ResearchMessageAttachment[] | undefined;
  /** The agent the post's AI follow-ups default to. */
  agent: NodeAgentInput;
}

/** Creates a thread whose root is a post (`create_research_post`). Its
 * format is derived from the text and its title is the text's first line. */
export function admitPost(
  db: SessionDatabase,
  userId: string,
  input: AdmitPostInput,
): ResearchTreeDetail {
  const text = noteText(input.text, "note cannot be empty");
  return transact(db, (tx) => {
    const detail = admitRoot(tx, userId, {
      workspaceId: input.workspaceId,
      type: "post",
      message: {
        text,
        ...(input.attachments && input.attachments.length > 0
          ? { attachments: input.attachments }
          : {}),
      },
      agent: input.agent,
    });
    markAttached(tx, imageIdsOf(input.attachments));
    return detail;
  });
}

/** Adds a follow-up note under a post (`create_research_post_follow_up`). It
 * inherits the parent's follow-up agent. */
export function admitFollowUpNote(
  db: SessionDatabase,
  userId: string,
  parentNodeId: string,
  text: string,
  attachments: ResearchMessageAttachment[] = [],
): ResearchNode {
  const body = noteText(text, "note cannot be empty");
  return transact(db, (tx) => {
    // Ownership first, so a foreign id is not found rather than refused.
    if (getNode(tx, userId, parentNodeId)) rejectTrashedNode(tx, parentNodeId);
    const node = admitChild(tx, userId, {
      parentNodeId,
      type: "post",
      message: { text: body, ...(attachments.length > 0 ? { attachments } : {}) },
    });
    markAttached(tx, imageIdsOf(attachments));
    return node;
  });
}

interface LoadedPost {
  node: NodeRow;
  tree: TreeRow;
  message: UserMessage;
}

/** A post `userId` may change: found, a post, and in a thread that is not in
 * the Trash. */
function loadPost(db: SessionDatabase, userId: string, nodeId: string): LoadedPost {
  const node = db
    .select()
    .from(nodes)
    .where(and(nodeOwnedBy(userId), eq(nodes.id, nodeId)))
    .get();
  if (!node) {
    throw new Error(`research node ${nodeId} was not found`);
  }
  const tree = db.select().from(trees).where(eq(trees.id, node.treeId)).get();
  if (!tree) {
    throw new Error(`research tree ${node.treeId} was not found`);
  }
  if (node.type !== "post" || node.messageJson === null) {
    throw new Error("only a note can be edited");
  }
  rejectTrashed(tree);
  return {
    node,
    tree,
    message: parseWireColumn<UserMessage>(
      userMessageSchema,
      node.messageJson,
      "nodes.message_json",
    ),
  };
}

export interface UpdatePostInput {
  nodeId: string;
  text: string;
  /** The text the editor opened with; a post that changed since is refused. */
  expectedText: string;
}

export interface UpdatePostResult {
  tree: ResearchTree;
  node: ResearchNode;
  removedHighlightCount: number;
  /** Whether the thread's title followed the text, so the caller announces
   * the tree as well. */
  titleChanged: boolean;
}

/**
 * Edits a note: a thread's root post or a follow-up note
 * (`update_research_post`). It gets the new text, its highlights move to
 * their quote in it (`reanchorResearchQuote`) or are removed when the quote
 * is gone, its format follows the text, and it is marked edited. For the
 * root, the thread title follows the text when it was still the title
 * derived from the old text. Replies and follow-ups are kept as they are.
 *
 * Refused when the text is empty, over the limit, unchanged, or no longer
 * `expectedText`; when an attached X post's link is missing from the new
 * text; and in an archived thread or one in the Trash.
 */
export function updatePost(
  db: SessionDatabase,
  userId: string,
  input: UpdatePostInput,
): UpdatePostResult {
  const text = noteText(input.text, "the note cannot be empty");
  return transact(db, (tx) => {
    const { node, tree, message } = loadPost(tx, userId, input.nodeId);
    if (tree.archivedAt !== null) {
      throw new Error("restore archived research before editing its note");
    }
    if (message.text !== input.expectedText) {
      throw new Error("the note changed while you were editing; reopen the editor and try again");
    }
    if (text === message.text.trim()) {
      throw new Error("the note's text is unchanged");
    }
    // An attached X post keeps the link it was captured from. A saved link
    // may otherwise take any text; its format follows the text.
    for (const attachment of message.attachments ?? []) {
      if (attachment.kind === "tweet" && !text.includes(attachment.sourceUrl)) {
        throw new Error(
          `keep the link ${attachment.sourceUrl} in the text: the attached X post was captured from it`,
        );
      }
    }

    let removedHighlightCount = 0;
    for (const row of tx.select().from(highlights).where(eq(highlights.nodeId, node.id)).all()) {
      const highlight = toResearchHighlight(row);
      const outcome = reanchorResearchQuote(highlight.anchor, message.text, text);
      if (outcome.kind === "unmatched") {
        tx.delete(highlights).where(eq(highlights.id, row.id)).run();
        removedHighlightCount += 1;
      } else if (outcome.kind === "moved") {
        tx.update(highlights)
          .set({ anchorJson: { ...highlight.anchor, start: outcome.start, end: outcome.end } })
          .where(eq(highlights.id, row.id))
          .run();
      }
    }

    const at = now();
    tx.update(nodes)
      .set({
        messageJson: { ...message, text },
        format: postFormatOf(text),
        editedAt: at,
      })
      .where(eq(nodes.id, node.id))
      .run();

    // A follow-up note's text does not name the thread.
    const isRoot = node.parentNodeId === null && tree.rootNodeId === node.id;
    const title =
      isRoot && tree.title === postDefaultTitle(message.text) ? postDefaultTitle(text) : tree.title;
    const treeRow = tx
      .update(trees)
      .set({ title, updatedAt: strictlyAfter(tree.updatedAt, at) })
      .where(eq(trees.id, tree.id))
      .returning()
      .get();
    if (!treeRow) {
      throw new Error(`research tree ${tree.id} was not found`);
    }
    const updated = getNode(tx, userId, node.id);
    if (!updated) {
      throw new Error(`research node ${node.id} was not found`);
    }
    return {
      tree: treeFor(tx, userId, treeRow),
      node: updated,
      removedHighlightCount,
      titleChanged: title !== tree.title,
    };
  });
}

/** The post's message, for a caller that re-resolves its attachments. */
export function message(db: SessionDatabase, userId: string, nodeId: string): UserMessage {
  return loadPost(db, userId, nodeId).message;
}

/**
 * Replaces the X post attachments of a post with a fresh resolution of the
 * same posts (`hydratePostTweet`). Each replacement must name a tweet the
 * post already carries, so the text and its attachments stay in agreement;
 * other attachments are kept in place.
 */
export function replaceTweetAttachments(
  db: SessionDatabase,
  userId: string,
  nodeId: string,
  replacements: readonly ResearchMessageAttachment[],
): ResearchNode {
  return transact(db, (tx) => {
    const { node, message: current } = loadPost(tx, userId, nodeId);
    const byTweet = new Map(
      replacements.flatMap((attachment) =>
        attachment.kind === "tweet" ? [[attachment.tweetId, attachment] as const] : [],
      ),
    );
    const attachments = (current.attachments ?? []).map((attachment) =>
      attachment.kind === "tweet" ? (byTweet.get(attachment.tweetId) ?? attachment) : attachment,
    );
    tx.update(nodes)
      .set({ messageJson: { ...current, attachments } })
      .where(eq(nodes.id, node.id))
      .run();
    const updated = getNode(tx, userId, node.id);
    if (!updated) {
      throw new Error(`research node ${node.id} was not found`);
    }
    return updated;
  });
}
