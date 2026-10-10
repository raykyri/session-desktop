// Readers for the node union (src/types.ts ResearchNode, the backend's
// ResearchNodeView). They mirror ResearchNode::node_type, follow_up_launch
// and recap_eligible in research.rs, and read the fields only some node
// types carry with one answer for the others.

import type {
  AgentSpec,
  DocumentSource,
  NoteDelivery,
  PostFormat,
  ResearchHighlightAnchor,
  ResearchMessageAttachment,
  ResearchNode,
  ResearchNodeStatus,
  ResearchNodeType,
  ResearchRecap,
  RunState,
} from "../types";

/** A node, or a feed entry, which carries the same tag (absent in hand-built
 * fixtures, where it reads as an exchange). */
type Typed = { type?: ResearchNodeType; source?: DocumentSource | null };

export function nodeType(node: Typed): ResearchNodeType {
  return node.type ?? "exchange";
}

/** What a person wrote, as the node's row in the messages column. */
interface ResearchUserMessage {
  /** Markdown, or a single URL when the post is a link. */
  text: string;
  attachments: ResearchMessageAttachment[];
}

/** The node's user message: a post's text, an exchange's question, or the
 * question an imported report answers. Null for a document with no question
 * (an authored document or a transcript), which shows as one row for the
 * whole document. */
export function nodeMessage(node: ResearchNode): ResearchUserMessage | null {
  if (!node.message) {
    return null;
  }
  return { text: node.message.text, attachments: node.message.attachments ?? [] };
}

/** The message text, or "" for a document without one. */
export function nodePrompt(node: ResearchNode): string {
  return node.message?.text ?? "";
}

export function nodeAttachments(node: ResearchNode): ResearchMessageAttachment[] {
  return node.message?.attachments ?? [];
}

/** An exchange's run; posts and documents have none. */
export function nodeRun(node: ResearchNode): RunState | null {
  return node.type === "exchange" ? node.run : null;
}

/** The run's status; posts and documents have no run and read as complete. */
export function nodeStatus(node: ResearchNode): ResearchNodeStatus {
  return node.type === "exchange" ? node.run.status : "complete";
}

/** An exchange's agent, or the default agent for a post's or document's AI
 * follow-ups. */
export function nodeAgent(node: ResearchNode): AgentSpec | null {
  if (node.type === "exchange") return node.agent;
  return node.followUpAgent ?? null;
}

/** The adapter of `nodeAgent`, or "" when the node names none. */
export function nodeAdapter(node: ResearchNode): string {
  return nodeAgent(node)?.adapter ?? "";
}

export function nodeRecap(node: ResearchNode): ResearchRecap | null {
  return node.type === "post" ? null : (node.recap ?? null);
}

export function nodeDelivery(node: ResearchNode): NoteDelivery | null {
  return node.type === "post" ? (node.delivery ?? null) : null;
}

/** When the node's response snapshot was last written: an exchange's answer
 * or a document's body. */
export function nodeResponseSnapshotAt(node: ResearchNode): number | null {
  if (node.type === "exchange") return node.run.responseSnapshotAt ?? null;
  if (node.type === "document") return node.responseSnapshotAt ?? null;
  return null;
}

/** When a post's text or a document's body was last replaced by an edit. */
export function nodeEditedAt(node: ResearchNode): number | null {
  return node.type === "exchange" ? null : (node.editedAt ?? null);
}

/** A document's source, or null for posts and exchanges. */
export function documentSource(node: Typed): DocumentSource | null {
  return nodeType(node) === "document" ? (node.source ?? null) : null;
}

/** Whether a document's snapshot is editable Markdown: an imported report or
 * an authored document, not a transcript. */
export function documentHoldsMarkdown(node: ResearchNode): boolean {
  return node.type === "document" && node.source !== "transcript";
}

/** How a follow-up launches: an exchange forks its native session (which
 * needs its recorded checkpoint); posts and documents start a fresh run with
 * their saved content as context. */
export function followUpLaunch(node: Typed): "fork" | "context" {
  return nodeType(node) === "exchange" ? "fork" : "context";
}

/** Whether a summary (recap) belongs to the node: exchanges and imported
 * reports. */
export function recapEligible(node: Typed): boolean {
  return nodeType(node) === "exchange" || documentSource(node) === "imported";
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

/** The excerpt a follow-up of a post quotes as its source: the reply it was
 * asked about, else the post's own text, on one line, without emphasis and
 * code markers, and cut at a word boundary to at most `maxChars` characters
 * (the ellipsis included). Null when `parent` is not a post. */
export function postFollowUpSourceExcerpt(
  parent: ResearchNode,
  child: Pick<ResearchNode, "anchor">,
  maxChars = 120,
): string | null {
  if (parent.type !== "post") {
    return null;
  }
  const replyId = replyAnchorId(child);
  const reply = replyId ? parent.delivery?.replies?.find((candidate) => candidate.id === replyId) : undefined;
  const text = (reply?.body ?? parent.message.text)
    .replace(/\*\*|__|`/g, "")
    .split(/\s+/)
    .join(" ")
    .trim();
  if (text.length <= maxChars) {
    return text;
  }
  const cut = text.slice(0, maxChars - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > maxChars / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
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
