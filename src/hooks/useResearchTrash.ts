import { useCallback, useEffect, useRef, useState } from "react";
import type { ResearchTreeSummary } from "../types";
import { listResearchTrash } from "../lib/api";

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The trees in the Trash of every workspace, loaded on mount and again by
 * `refresh` (on research.trash.changed). `refresh` is stable; a response
 * older than the latest request is dropped. */
export function useResearchTrash(onError: (message: string) => void) {
  const [trees, setTrees] = useState<ResearchTreeSummary[]>([]);
  const requestSeqRef = useRef(0);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const refresh = useCallback(async () => {
    const seq = ++requestSeqRef.current;
    try {
      const next = await listResearchTrash();
      if (seq === requestSeqRef.current) setTrees(next);
    } catch (err) {
      if (seq === requestSeqRef.current) onErrorRef.current(errorMessage(err));
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return { trees, refresh };
}
