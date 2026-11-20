// Accessor helpers for the node union (src/types.ts ResearchNode, the backend's
// ResearchNodeView). They mirror ResearchNode::node_type, follow_up_launch
// and recap_eligible in research.rs, and read the fields only some node
// types carry with one answer for the others.

import type {
  AgentSpec,
  DocumentSource,
  PostFormat,
  ResearchHighlightAnchor,
  ResearchMessageAttachment,
  ResearchNode,
  ResearchNodeStatus,
  ResearchNodeType,
  ResearchRecap,
  RunState,
} from "../wire/index.js";

/** Returns the node type tag. Hand-built fixtures without a tag are exchanges. */
type Typed = { type?: ResearchNodeType | undefined; source?: DocumentSource | null };

export function nodeType(node: Typed): ResearchNodeType {
  return node.type ?? "exchange";
}

/** User-authored message text, as the node's row in the messages column. */
interface ResearchUserMessage {
  /** Markdown, or a single URL when the post is a link. */
  text: string;
  attachments: ResearchMessageAttachment[];
}

/** The node's user message as a question row: a post's text, an exchange's
 * question, or the question an imported report answers. Null for a
 * transcript and for a document without a message (an authored document),
 * which show as one row for the whole document. A transcript's message is
 * its first user turn, which the transcript itself shows; feed cards display
 * it through nodePrompt. */
export function nodeMessage(node: ResearchNode): ResearchUserMessage | null {
  if (!node.message || (node.type === "document" && node.source === "transcript")) {
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

/** The run's status; posts and documents have no run and are treated as complete. */
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

/** The fields of an agent adapter (the desktop's AgentAdapterMetadata) that
 * `followUpAdapter` reads. */
interface FollowUpAdapterOption {
  id: string;
  default: boolean;
  supportsResearch: boolean;
  researchReadiness: string;
}

/** The adapter a follow-up of `parent` runs on, as the backend picks it
 * (create_research_child in state.rs): an exchange's own agent; a post's,
 * an imported report's, or a transcript's follow-up agent when it supports
 * research; otherwise, and always for an authored document, the ready
 * research adapter marked default, else the first ready research adapter
 * (`default_fork_adapter`). Null when no adapter is ready for research. */
export function followUpAdapter(
  parent: ResearchNode,
  adapters: readonly FollowUpAdapterOption[],
): string | null {
  if (parent.type === "exchange") return parent.agent.adapter || null;
  const ready = adapters.filter(
    (adapter) => adapter.supportsResearch && adapter.researchReadiness === "ready",
  );
  const fallback = (ready.find((adapter) => adapter.default) ?? ready[0])?.id ?? null;
  if (documentSource(parent) === "authored") return fallback;
  const own = nodeAdapter(parent);
  return own && adapters.some((adapter) => adapter.id === own && adapter.supportsResearch)
    ? own
    : fallback;
}

/** Whether a summary (recap) belongs to the node: exchanges and imported
 * reports. */
export function recapEligible(node: Typed): boolean {
  return nodeType(node) === "exchange" || documentSource(node) === "imported";
}

/** The passage of the parent's answer a follow-up was asked about. */
export function passageAnchor(node: Pick<ResearchNode, "anchor">): ResearchHighlightAnchor | null {
  return node.anchor?.kind === "passage" ? node.anchor.anchor : null;
}

/** The excerpt a follow-up of a note quotes as its source: the note's text
 * on one line, without emphasis and code markers, and cut at a word boundary
 * to at most `maxChars` characters (the ellipsis included).
 * Null when `parent` is not a post (a note). */
export function postFollowUpSourceExcerpt(parent: ResearchNode, maxChars = 120): string | null {
  if (parent.type !== "post") {
    return null;
  }
  const text = parent.message.text
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
