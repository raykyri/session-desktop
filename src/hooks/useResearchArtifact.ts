import { useEffect, useState } from "react";
import { registerResearchArtifact, type ResearchArtifactRevision } from "../lib/api";
import { sessionWidgetMetadata } from "@session/shared/lib/sessionWidgets";
import type { WidgetAnswer } from "@session/shared/lib/sessionWidgetActions";

/** Streaming fences stay ephemeral. Settled answers pin immutable source. */
export function useResearchArtifact(answer: WidgetAnswer | null, html: string, meta: string, slot: string, streaming: boolean) {
  const [record, setRecord] = useState<{ key: string; revision: ResearchArtifactRevision } | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const treeId = answer?.treeId;
  const nodeId = answer?.nodeId;
  const ownerSlot = `${answer?.messageKey ?? "answer"}:${slot}`;
  const key = JSON.stringify([treeId, nodeId, ownerSlot, html, meta]);
  useEffect(() => {
    if (!treeId || !nodeId || streaming) return;
    let cancelled = false;
    setError("");
    registerResearchArtifact({ treeId, nodeId, slot: ownerSlot, html, ...sessionWidgetMetadata(meta) }).then(
      (revision) => { if (!cancelled) setRecord({ key, revision }); },
      () => { if (!cancelled) setError("Revision could not be saved"); },
    );
    return () => { cancelled = true; };
  }, [treeId, nodeId, ownerSlot, html, meta, key, streaming, attempt]);
  return { revision: record?.key === key ? record.revision : null, error, retry: () => setAttempt((value) => value + 1) };
}
