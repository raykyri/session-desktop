import { useCallback, useEffect, useRef, useState } from "react";
import { listResearchHighlights, removeResearchHighlights } from "../lib/api";
import type { ResearchHighlightFeedItem } from "../types";

/**
 * The Highlights feed's list. It is fetched whole (highlights are few and
 * unpaged) while `visible`, and again after `invalidate`, which highlight,
 * node and tree events call so an open feed refetches.
 */
export function useResearchHighlights(visible: boolean, onError: (message: string) => void) {
  const [items, setItems] = useState<ResearchHighlightFeedItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const requestSeqRef = useRef(0);
  const refresh = useCallback(async () => {
    const requestSeq = requestSeqRef.current + 1;
    requestSeqRef.current = requestSeq;
    setLoading(true);
    try {
      const next = await listResearchHighlights();
      if (requestSeqRef.current !== requestSeq) return;
      setItems(next);
      setError(null);
    } catch (err) {
      if (requestSeqRef.current !== requestSeq) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (requestSeqRef.current === requestSeq) {
        setLoading(false);
      }
    }
  }, []);
  useEffect(() => {
    if (!visible) return;
    void refresh();
  }, [visible, refresh, version]);
  const invalidate = useCallback(() => {
    setVersion((current) => current + 1);
  }, []);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const remove = useCallback(
    (item: ResearchHighlightFeedItem) => {
      void removeResearchHighlights(item.nodeId, [item.highlightId])
        .then(() => refresh())
        .catch((err: unknown) =>
          onErrorRef.current(err instanceof Error ? err.message : String(err)),
        );
    },
    [refresh],
  );
  return { items, loading, error, refresh, invalidate, remove };
}
