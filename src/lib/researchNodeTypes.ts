// Derive node type and follow-up launch behavior from stored kind and origin.
// These helpers mirror ResearchNode::node_type and follow_up_launch in research.rs.

import type { ResearchMessageAttachment, ResearchNode } from "../types";

/** - post: a note, written by you (a saved link or tweet, or a post
 *    delivered to the network).
 *  - exchange: a question and the agent run that answers it.
 *  - document: long-form content with no run behind it: an imported report,
 *    an authored document, or an exported terminal conversation. */
type ResearchNodeType = "post" | "exchange" | "document";

type NodeShape = Pick<ResearchNode, "kind" | "origin">;

export function nodeType(node: NodeShape): ResearchNodeType {
  switch (node.kind ?? "run") {
    case "note":
      return "post";
    case "document":
    case "conversation":
      return "document";
    default:
      return "exchange";
  }
}

/** What a person wrote, as the node's row in the messages column. */
interface ResearchUserMessage {
  /** Markdown, or a single URL when the post is a link. */
  text: string;
  attachments: ResearchMessageAttachment[];
}

/** The node's user message: a post's text, an exchange's question, or the
 * question an imported report answers. Null for a document with no question
 * (an authored document or an exported conversation), which shows as one
 * row for the whole document. */
export function nodeMessage(
  node: NodeShape & Pick<ResearchNode, "prompt" | "attachments">,
): ResearchUserMessage | null {
  if (nodeType(node) === "document" && node.origin !== "imported") {
    return null;
  }
  return { text: node.prompt, attachments: node.attachments ?? [] };
}

/** How a follow-up launches: an exchange forks its native session (which
 * needs its recorded checkpoint); posts and documents start a fresh run with
 * their saved content as context. */
export function followUpLaunch(node: NodeShape): "fork" | "context" {
  return nodeType(node) === "exchange" ? "fork" : "context";
}

/** Whether a summary (recap) belongs to the node: exchanges and imported
 * reports. */
export function recapEligible(node: NodeShape): boolean {
  return nodeType(node) === "exchange" || node.origin === "imported";
}
