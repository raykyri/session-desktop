// Derive node type and follow-up launch behavior from stored kind and origin.
// These helpers mirror ResearchNode::node_type and follow_up_launch in research.rs.

import type {
  PostFormat,
  ResearchHighlightAnchor,
  ResearchMessageAttachment,
  ResearchNode,
} from "../types";

/** - post: written by you (a saved link or tweet, or a post
 *    delivered to the network).
 *  - exchange: a question and the agent run that answers it.
 *  - document: long-form content with no run behind it: an imported report,
 *    an authored document, or an exported terminal conversation. */
type ResearchNodeType = "post" | "exchange" | "document";

type NodeShape = Pick<ResearchNode, "kind" | "origin">;

export function nodeType(node: NodeShape): ResearchNodeType {
  switch (node.kind ?? "run") {
    case "post":
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

/** The passage of the parent's answer a follow-up was asked about. */
export function passageAnchor(
  node: Pick<ResearchNode, "anchor">,
): ResearchHighlightAnchor | null {
  return node.anchor?.kind === "passage" ? node.anchor.anchor : null;
}

/** The id of the parent post's reply a follow-up was asked about. */
export function replyAnchorId(node: Pick<ResearchNode, "anchor">): string | null {
  return node.anchor?.kind === "reply" ? node.anchor.replyId : null;
}

/** The format the backend stores for a post with this text
 * (`PostFormat::of`): "link" when the whole text is one http(s) URL. The
 * composer uses it to label and route what it is about to create; stored
 * posts carry their format. */
export function postFormatOf(text: string): PostFormat {
  const trimmed = text.trim();
  if (!trimmed || /\s/.test(trimmed)) return "text";
  try {
    const url = new URL(trimmed);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname
      ? "link"
      : "text";
  } catch {
    return "text";
  }
}
