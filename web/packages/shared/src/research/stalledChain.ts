// The note an ask box displays, and the rejection `followups.ask` returns,
// when the last answer of an inline chain stopped and will not complete on its
// own (web only). The author of that answer pays for its runs, so only
// they can retry it; the desktop's wording (`researchChainComposerState`) is
// theirs. Other users in a shared thread are informed who can retry it and what
// actions they can take instead.

/** The desktop's notes, for the person who can retry the answer. */
export const STALLED_TAIL_MESSAGES = {
  failed: "The last answer stopped with an error. Retry it or edit its question to continue.",
  stopped: "The last answer was stopped. Run it again to continue.",
} as const;

export interface StalledTailNoteInput {
  /** How the last answer ended: with an error (failed, or interrupted and
   * not resuming) or stopped (cancelled). */
  status: "failed" | "stopped";
  /** The current user pays for the answer's runs (its author, or the owner when
   * the author's account is gone): they can retry it. */
  readerIsPayer: boolean;
  /** The current user owns the thread: they can delete the answer. */
  readerIsOwner: boolean;
  /** The payer is the thread's owner. */
  payerIsOwner: boolean;
  /** The payer's name, or their login when they have no name. */
  payerName: string;
}

/**
 * The note for a user viewing a chain whose last answer stopped. The payer
 * receives the desktop's wording. Other users are informed that only the payer
 * can retry it, that the owner can delete it (or, for the owner, to delete it),
 * and to branch from the preceding answer to continue.
 */
export function stalledTailNote(input: StalledTailNoteInput): string {
  if (input.readerIsPayer) {
    return STALLED_TAIL_MESSAGES[input.status];
  }
  const branch = "Branch from the answer before it to continue.";
  if (input.payerIsOwner) {
    return `The last answer stopped. Only ${input.payerName} can retry or delete it. ${branch}`;
  }
  if (input.readerIsOwner) {
    return `The last answer stopped. Only ${input.payerName} can retry it. Delete it, or branch from the answer before it to continue.`;
  }
  return `The last answer stopped. Only ${input.payerName} can retry it; the owner can delete it. ${branch}`;
}
