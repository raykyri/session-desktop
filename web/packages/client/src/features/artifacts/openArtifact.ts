// Opening a document in the preview panel (`11-artifacts-and-browser.md` §3).
//
// A separate module from the panel so a chip can open one without importing
// the component, and from the store so the store stays free of the API layer.

import { mintArtifactToken } from "../../api/api.js";
import { reusableToken, useArtifactPanelStore } from "../../stores/artifactPanel.js";

export interface OpenArtifactRequest {
  documentId: string;
  /** The name shown in the address row while the panel is open. */
  name: string;
}

/**
 * Generates a preview token and opens the document, reusing an unexpired token
 * when available. Rejects on failure so the caller can report the error at the
 * interaction point.
 */
export async function openArtifactDocument(request: OpenArtifactRequest): Promise<void> {
  const store = useArtifactPanelStore.getState();
  const reusable = reusableToken(store, request.documentId);
  if (reusable) {
    store.open({ ...reusable, name: request.name });
    return;
  }
  const minted = await mintArtifactToken(request.documentId);
  useArtifactPanelStore.getState().open({
    documentId: request.documentId,
    name: request.name,
    url: minted.url,
    expiresAt: minted.expiresAt,
  });
}
