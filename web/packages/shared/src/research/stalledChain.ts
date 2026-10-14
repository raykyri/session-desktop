// The note an ask box shows, and the refusal `followups.ask` answers with,
// when the last answer of an inline chain stopped and will not complete on its
// own (web only). The person who asked that answer pays for its runs, so only
// they can retry it; the desktop's wording (`researchChainComposerState`) is
// theirs. Anyone else in a shared thread is told who can retry it and what
// they can do instead.

/** The desktop's notes, for the person who can retry the answer. */
export const STALLED_TAIL_MESSAGES = {
  failed: "The last answer stopped with an error. Retry it or edit its question to continue.",
  stopped: "The last answer was stopped. Run it again to continue.",
} as const;

export interface StalledTailNoteInput {
  /** How the last answer ended: with an error (failed, or interrupted and
   * not resuming) or stopped (cancelled). */
  status: "failed" | "stopped";
  /** The reader pays for the answer's runs (its author, or the owner when
   * the author's account is gone): they can retry it. */
  readerIsPayer: boolean;
  /** The reader owns the thread: they can delete the answer. */
  readerIsOwner: boolean;
  /** The payer is the thread's owner. */
  payerIsOwner: boolean;
  /** The payer's name, or their login when they have no name. */
  payerName: string;
}

/**
 * The note for a reader of a chain whose last answer stopped. The payer
 * reads the desktop's sentence. Anyone else is told that only the payer can
 * retry it, that the owner can delete it (or, for the owner, to delete it),
 * and to branch from the answer before it to continue.
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
