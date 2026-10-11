// Pure rules of the thread page (ResearchThreadPage): labels, branch
// blockers, editor statistics, and the record helpers its per-node caches
// share.

import { countUnmatchedResearchAnchors } from "./researchAnchors";
import { researchQueueStep } from "./researchBranchView";
import {
  canContinueChain,
  canFollowUpFrom,
  chainComposerPlaceholder,
  isActiveResearchStatus,
} from "./researchChains";
import {
  RESEARCH_DOCUMENT_BYTE_LIMIT,
  RESEARCH_DOCUMENT_WORD_LIMIT,
  ResearchDocumentWordLimitExceeded,
  countResearchDocumentWords,
  researchDocumentEditGate,
} from "./researchDocuments";
import { nodePrompt, nodeStatus } from "./researchNodeTypes";
import type { ResearchHighlightAnchor, ResearchNode } from "../types";

/** Removes the given keys from a record, keeping the identity when none are
 * present — the shape every per-node cache invalidation needs. */
export function withoutKeys<T>(record: Record<string, T>, keys: Iterable<string>): Record<string, T> {
  const stale = [...keys].filter((key) => key in record);
  if (stale.length === 0) {
    return record;
  }
  const next = { ...record };
  for (const key of stale) {
    delete next[key];
  }
  return next;
}

export function sameIds(previous: readonly string[], candidate: readonly string[]) {
  return (
    previous.length === candidate.length &&
    previous.every((id, index) => id === candidate[index])
  );
}

export function sameNumberRecord(a: Record<string, number>, b: Record<string, number>) {
  const aKeys = Object.keys(a);
  return (
    aKeys.length === Object.keys(b).length &&
    aKeys.every((key) => a[key] === b[key])
  );
}

/** A node's title, else its question, else `fallback`. */
export function researchNodeLabel(node: ResearchNode | null | undefined, fallback: string) {
  return (node?.title ?? (node ? nodePrompt(node) : "")).trim() || fallback;
}

/** Why no branch can start from `node`, or null when one can. */
export function researchBranchBlocker(node: ResearchNode | null | undefined, archived: boolean) {
  if (archived) {
    return "Move this question out of Archive to branch from it";
  }
  if (!node || isActiveResearchStatus(nodeStatus(node))) {
    return "Wait for the answer to finish";
  }
  if (nodeStatus(node) === "failed") {
    return "This answer stopped with an error. Retry it to branch from it";
  }
  if (nodeStatus(node) === "cancelled") {
    return "This answer was stopped. Run it again to branch from it";
  }
  return canFollowUpFrom(node) ? null : "Waiting for the native session checkpoint";
}

/** The quoted selection as a single line: block structure and inline markdown
 * are already absent from the rendered-text projection, so collapsing
 * whitespace is all that quoting requires. */
export function researchQuoteText(exact: string) {
  return exact.split(/\s+/).join(" ").trim();
}

/** `text.slice(start, end)`, clamped to the text and widened so it never
 * splits a UTF-16 surrogate pair. Anchor context is taken with this. */
export function surrogateSafeSlice(text: string, start: number, end: number) {
  let safeStart = Math.max(0, start);
  let safeEnd = Math.min(text.length, end);
  if (
    safeStart > 0 &&
    safeStart < text.length &&
    /[\uDC00-\uDFFF]/.test(text[safeStart]) &&
    /[\uD800-\uDBFF]/.test(text[safeStart - 1])
  ) {
    safeStart -= 1;
  }
  if (
    safeEnd > 0 &&
    safeEnd < text.length &&
    /[\uD800-\uDBFF]/.test(text[safeEnd - 1]) &&
    /[\uDC00-\uDFFF]/.test(text[safeEnd])
  ) {
    safeEnd += 1;
  }
  return text.slice(safeStart, safeEnd);
}

/** `rootId` and every node below it. */
export function researchSubtreeIds(nodes: readonly ResearchNode[], rootId: string): Set<string> {
  const subtree = new Set([rootId]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const node of nodes) {
      if (node.parentNodeId && subtree.has(node.parentNodeId) && !subtree.has(node.id)) {
        subtree.add(node.id);
        grew = true;
      }
    }
  }
  return subtree;
}

/** Whether any node in the branch headed by `headId`, or in a branch below
 * it, is running or queued. */
export function researchSubtreeBusy(nodes: readonly ResearchNode[], headId: string) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const stack = [headId];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = byId.get(id);
    if (node && isActiveResearchStatus(nodeStatus(node))) {
      return true;
    }
    for (const candidate of nodes) {
      if (candidate.parentNodeId === id) {
        stack.push(candidate.id);
      }
    }
  }
  return false;
}

/** The delete action's label for a message: the whole research for the
 * root, else what the deletion takes with it. */
export function researchDeleteLabel(isRoot: boolean, inline: boolean | undefined, descendantCount: number) {
  if (isRoot) {
    return "Delete research";
  }
  if (descendantCount === 0) {
    return "Delete follow-up";
  }
  return inline ? "Delete from here" : "Delete branch";
}

/** Counts for the editor column, from the session's fixed inputs and the
 * text in the field. Documents count words and bytes against their limits;
 * both kinds count the highlights (and, for documents, the branch passages)
 * the edit leaves without a match. */
interface ResearchEditorStats {
  wordCount: number;
  overWordLimit: boolean;
  overByteLimit: boolean;
  removedHighlights: number;
  unmatchedBranches: number;
}

export function researchEditorStats(
  session: {
    kind: "document" | "post";
    initialText: string;
    highlightAnchors: readonly ResearchHighlightAnchor[];
    branchAnchors: readonly ResearchHighlightAnchor[];
  },
  text: string,
): ResearchEditorStats {
  let wordCount = 0;
  let overWordLimit = false;
  if (session.kind === "document") {
    try {
      wordCount = countResearchDocumentWords(text, RESEARCH_DOCUMENT_WORD_LIMIT);
    } catch (caught) {
      if (!(caught instanceof ResearchDocumentWordLimitExceeded)) {
        throw caught;
      }
      wordCount = caught.count;
      overWordLimit = true;
    }
  }
  return {
    wordCount,
    overWordLimit,
    overByteLimit:
      session.kind === "document" && new TextEncoder().encode(text).length > RESEARCH_DOCUMENT_BYTE_LIMIT,
    removedHighlights: countUnmatchedResearchAnchors(session.highlightAnchors, session.initialText, text),
    unmatchedBranches:
      session.kind === "document"
        ? countUnmatchedResearchAnchors(session.branchAnchors, session.initialText, text)
        : 0,
  };
}

/** Whether the editor column's session can be saved: a note whose trimmed
 * text changed and is not empty, or a document that passes
 * researchDocumentEditGate. */
export function researchEditorCanSave(
  session: { kind: "document" | "post"; text: string; initialText: string; title: string; initialTitle: string },
  stats: Pick<ResearchEditorStats, "overWordLimit" | "overByteLimit"> | null,
) {
  if (session.kind === "post") {
    return Boolean(session.text.trim()) && session.text.trim() !== session.initialText.trim();
  }
  return researchDocumentEditGate({
    markdown: session.text,
    initialMarkdown: session.initialText,
    title: session.title,
    initialTitle: session.initialTitle,
    overWordLimit: stats?.overWordLimit ?? false,
    overByteLimit: stats?.overByteLimit ?? false,
  }).canSave;
}

/** A messages column's ask box: whether it can send, whether it is
 * disabled, the note under it and its placeholder. It continues the chain
 * whose messages are `chain` (queueing while the tail runs), or replaces a
 * failed question being edited. */
export function researchChainComposerState({
  nodes,
  chain,
  editing,
  queued,
  archived,
}: {
  /** The tree's nodes. */
  nodes: ResearchNode[];
  /** The chain's messages, head first; not empty. */
  chain: readonly ResearchNode[];
  /** A failed question of the chain is being edited. */
  editing: boolean;
  /** The chain has queued follow-ups. */
  queued: boolean;
  archived: boolean;
}) {
  const head = chain[0];
  const tail = chain[chain.length - 1];
  const step = researchQueueStep(tail);
  const awaitingCheckpoint = nodeStatus(tail) === "complete" && !canFollowUpFrom(tail);
  const canSend = !archived && (editing || step === "wait" || queued || canContinueChain(nodes, tail));
  const note = editing
    ? null
    : archived
      ? "Archived questions are read-only. Move the question out of Archive to continue."
      : awaitingCheckpoint
        ? "Waiting for the native session checkpoint before continuing."
        : step === "stalled" && !queued
          ? nodeStatus(tail) === "failed"
            ? "The last answer stopped with an error. Retry it or edit its question to continue."
            : "The last answer was stopped. Run it again to continue."
          : null;
  const busy = chain.some((node) => isActiveResearchStatus(nodeStatus(node)));
  return {
    canSend,
    disabled: archived || (step === "stalled" && !editing && !queued),
    note,
    placeholder: editing ? "Edit the question" : chainComposerPlaceholder(head, chain.length, busy || queued),
  };
}

/** A margin marker's accessible label: how many branches it stands for and
 * from where, whether one is open (a click closes it) or running, and the
 * question a click opens. */
export function researchMarkerLabel({
  count,
  whole,
  open,
  running,
  targetPrompt,
}: {
  count: number;
  /** The marker stands for branches from the whole answer. */
  whole: boolean;
  open: boolean;
  running: boolean;
  targetPrompt: string;
}) {
  const what =
    count === 1
      ? whole
        ? "1 branch from the whole answer"
        : "1 branch from this paragraph"
      : `${count} branches from ${whole ? "the whole answer" : "this paragraph"}`;
  return open
    ? `${what}, one is open${running ? ", running" : ""}. Closes it.`
    : `${what}${running ? ", running" : ""}. Opens: ${targetPrompt.split(/\s+/).join(" ").trim().slice(0, 80)}`;
}
