/** The mounted editor can defer navigation until its unsaved changes are
 * discarded. Check before changing history, selection, or persisted state. */
type LeaveGuard = (proceed: () => void) => boolean;
let guard: LeaveGuard | null = null;

export function registerResearchEditorLeaveGuard(next: LeaveGuard): () => void {
  guard = next;
  return () => {
    if (guard === next) guard = null;
  };
}

/** True means the action was deferred; the caller must return immediately. */
export function deferResearchEditorLeave(proceed: () => void): boolean {
  return guard?.(proceed) ?? false;
}
