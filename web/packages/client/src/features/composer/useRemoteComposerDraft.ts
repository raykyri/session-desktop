import { useEffect, useLayoutEffect, useRef } from "react";

import { getDraft } from "../../api/api.js";
import { useMe } from "../../api/queries.js";
import { restoreServerDraft } from "../../stores/drafts.js";
import type { ComposerDraft, DraftKey } from "../../stores/drafts.js";

/** Restore on entering a signed-in draft scope without replacing active edits. */
export function useRemoteComposerDraft(key: DraftKey, apply: (draft: ComposerDraft) => void): void {
  const userId = useMe().data?.id;
  const applyRef = useRef(apply);
  useLayoutEffect(() => {
    applyRef.current = apply;
  }, [apply]);
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    void getDraft(key)
      .then((result) => {
        if (cancelled) return;
        const restored = restoreServerDraft(key, result.value);
        if (restored) applyRef.current(restored);
      })
      .catch(() => {
        // Local drafts remain usable; entering this scope again retries the read.
      });
    return () => {
      cancelled = true;
    };
  }, [key, userId]);
}
