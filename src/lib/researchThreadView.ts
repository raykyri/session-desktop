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

/** The state a branch control shows: "failed" when a message in the
 * branches, or in a branch below them, failed; else "running" when one is
 * running or queued; else null. `ofMessage` holds it for each message with
 * branches whose state is not null; `ofBranch` gives it for one branch (its
 * head, its follow-ups and everything below). */
export function researchBranchStates(
  nodes: readonly ResearchNode[],
  branchesByParent: ReadonlyMap<string, readonly ResearchNode[]>,
): {
  ofMessage: Map<string, "running" | "failed">;
  ofBranch: (branchId: string) => "running" | "failed" | null;
} {
  const children = new Map<string, ResearchNode[]>();
  for (const node of nodes) {
    if (node.parentNodeId) {
      const list = children.get(node.parentNodeId);
      if (list) list.push(node);
      else children.set(node.parentNodeId, [node]);
    }
  }
  // Each subtree's state, computed once; `seen` guards a malformed cycle.
  const subtree = new Map<string, "running" | "failed" | null>();
  const seen = new Set<string>();
  const stateOf = (node: ResearchNode): "running" | "failed" | null => {
    const known = subtree.get(node.id);
    if (known !== undefined) return known;
    if (seen.has(node.id)) return null;
    seen.add(node.id);
    const status = nodeStatus(node);
    let state: "running" | "failed" | null =
      status === "failed" ? "failed" : isActiveResearchStatus(status) ? "running" : null;
    for (const child of children.get(node.id) ?? []) {
      if (state === "failed") break;
      const below = stateOf(child);
      if (below === "failed" || (below === "running" && state === null)) state = below;
    }
    subtree.set(node.id, state);
    return state;
  };
  const states = new Map<string, "running" | "failed">();
  for (const [parentId, branches] of branchesByParent) {
    let state: "running" | "failed" | null = null;
    for (const branch of branches) {
      const below = stateOf(branch);
      if (below === "failed") {
        state = "failed";
        break;
      }
      if (below === "running") state = "running";
    }
    if (state) states.set(parentId, state);
  }
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return {
    ofMessage: states,
    ofBranch: (branchId) => {
      const branch = byId.get(branchId);
      return branch ? stateOf(branch) : null;
    },
  };
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

/** The editor session after a save that keeps the editor open (⌘S). The
 * text and title that were saved (`saved`, read when the save started)
 * become the initial ones, so the field reads as unchanged; what was typed
 * while the save ran still differs from them. The next save expects what the
 * backend stored: the note's trimmed text, the thread's title, the
 * document's new revision and the highlights that survived. */
export function researchEditorSessionSaved<
  S extends {
    kind: "document" | "post";
    initialText: string;
    initialTitle: string;
    expectedText: string;
    expectedTitle: string;
    responseRevision: string | null;
    highlightIds: string[];
    highlightAnchors: ResearchHighlightAnchor[];
  },
>(
  current: S,
  saved: { text: string; title: string },
  stored: { tree: { title: string }; node: ResearchNode; responseRevision?: string },
): S {
  const highlights = stored.node.highlights ?? [];
  return {
    ...current,
    initialText: saved.text,
    initialTitle: saved.title,
    expectedText: current.kind === "post" ? nodePrompt(stored.node) : saved.text,
    expectedTitle: current.kind === "document" ? stored.tree.title : current.expectedTitle,
    responseRevision: stored.responseRevision ?? current.responseRevision,
    highlightIds: highlights.map((highlight) => highlight.id),
    highlightAnchors: highlights.map((highlight) => highlight.anchor),
  };
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
 * from where, whether one is open (a click closes it), whether a message in
 * them is running or has failed, and the question a click opens. */
export function researchMarkerLabel({
  count,
  whole,
  open,
  state,
  targetPrompt,
}: {
  count: number;
  /** The marker stands for branches from the whole answer. */
  whole: boolean;
  open: boolean;
  state: "running" | "failed" | null;
  targetPrompt: string;
}) {
  const what =
    count === 1
      ? whole
        ? "1 branch from the whole answer"
        : "1 branch from this paragraph"
      : `${count} branches from ${whole ? "the whole answer" : "this paragraph"}`;
  const status = state ? `, ${state}` : "";
  return open
    ? `${what}, one is open${status}. Closes it.`
    : `${what}${status}. Opens: ${targetPrompt.split(/\s+/).join(" ").trim().slice(0, 80)}`;
}
