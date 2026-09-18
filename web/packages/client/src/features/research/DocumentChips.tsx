// The documents attached to a run, shown under its question
// (`09-research-document-view.md` §7).
//
// A chip names the file and opens it in the preview panel
// (`11-artifacts-and-browser.md` §3): the click mints a single-document token
// and hands the URL to `ArtifactPanel`, which frames it. "Open in new tab"
// lives in the panel's address row, so the chip no longer has to open a window
// before the mint resolves to keep the user gesture alive.

import { FileText } from "lucide-react";
import { useState } from "react";

import { useDocuments } from "../../api/queries.js";
import { openArtifactDocument } from "../artifacts/openArtifact.js";

export function DocumentChips({
  documentIds,
  workspaceId,
}: {
  documentIds: readonly string[];
  workspaceId: string;
}) {
  const documents = useDocuments(workspaceId);
  const [failed, setFailed] = useState<string | null>(null);
  const byId = new Map((documents.data ?? []).map((document) => [document.id, document]));

  const open = (documentId: string, name: string) => {
    openArtifactDocument({ documentId, name }).then(
      () => setFailed(null),
      () => setFailed(documentId),
    );
  };

  return (
    <div className="mb-[26px] flex max-w-[min(100%,640px)] flex-wrap gap-1.5">
      {documentIds.map((documentId) => {
        const info = byId.get(documentId);
        const name = info?.name ?? "Attached document";
        return (
          <button
            key={documentId}
            type="button"
            className="border-border-control bg-control text-fg-secondary hover:bg-control-hover focus-visible:ring-focus-ring inline-flex max-w-full items-center gap-1.5 rounded-md border px-2 py-1 text-xs outline-none focus-visible:ring-2"
            title={`${name} · Open in preview panel`}
            onClick={() => open(documentId, name)}
          >
            <FileText size={12} aria-hidden="true" />
            <span className="min-w-0 truncate">{name}</span>
            {info?.extractionStatus === "failed" ? (
              <span className="text-status-failed">Content unavailable</span>
            ) : null}
          </button>
        );
      })}
      {failed ? (
        <span className="text-status-failed text-xs" role="alert">
          Failed to open document.
        </span>
      ) : null}
    </div>
  );
}
