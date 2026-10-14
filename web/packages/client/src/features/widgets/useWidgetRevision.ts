// A widget's revision and its artifact's history (the desktop's
// `useResearchArtifact` and `useArtifactHistory`).

import type { ResearchArtifactRevision } from "@session/shared";
import { useCallback, useEffect, useRef, useState } from "react";

import { registerResearchArtifact, researchArtifactHistory } from "../../api/api.js";

/** Streaming fences stay ephemeral. Settled answers pin immutable source: the
 * server records the block it finds in the stored answer and returns its
 * revision. */
export function useWidgetRevision(
  nodeId: string | null,
  messageKey: string | undefined,
  html: string,
  meta: string,
  slot: string,
  streaming: boolean,
) {
  const [record, setRecord] = useState<{
    key: string;
    revision: ResearchArtifactRevision;
  } | null>(null);
  const [failure, setFailure] = useState<{ key: string; attempt: number } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const ownerSlot = `${messageKey ?? "answer"}:${slot}`;
  const key = JSON.stringify([nodeId, ownerSlot, html, meta]);
  useEffect(() => {
    if (!nodeId || streaming) return;
    let cancelled = false;
    registerResearchArtifact({ nodeId, slot: ownerSlot, html, meta }).then(
      (revision) => {
        if (!cancelled) setRecord({ key, revision });
      },
      () => {
        if (!cancelled) setFailure({ key, attempt });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [nodeId, ownerSlot, html, meta, key, streaming, attempt]);
  return {
    revision: record?.key === key ? record.revision : null,
    error:
      failure?.key === key && failure.attempt === attempt && record?.key !== key
        ? "Revision could not be saved"
        : "",
    retry: () => setAttempt((value) => value + 1),
  };
}

export type ArtifactHistory =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; revisions: ResearchArtifactRevision[]; unresolved: number };

/** The revision history of a widget's artifact, loaded on request and kept
 * until the revision changes. A failed load is retried on the next request. */
export function useArtifactHistory(revision: ResearchArtifactRevision | null) {
  const key = revision
    ? JSON.stringify([revision.treeId, revision.artifactId, revision.revision])
    : null;
  const [state, setState] = useState<{ key: string | null; history: ArtifactHistory }>({
    key,
    history: { status: "idle" },
  });
  const keyRef = useRef(key);
  useEffect(() => {
    keyRef.current = key;
  });
  const history: ArtifactHistory = state.key === key ? state.history : { status: "idle" };
  const load = useCallback(() => {
    if (!revision || !key) return;
    if (history.status === "loading" || history.status === "ready") return;
    setState({ key, history: { status: "loading" } });
    researchArtifactHistory(revision.treeId, revision.artifactId).then(
      (result) => {
        if (keyRef.current === key)
          setState({
            key,
            history: {
              status: "ready",
              revisions: result.revisions,
              unresolved: result.unresolved,
            },
          });
      },
      () => {
        if (keyRef.current === key)
          setState({ key, history: { status: "error", message: "Revision history unavailable" } });
      },
    );
  }, [revision, key, history.status]);
  return { history, load };
}
