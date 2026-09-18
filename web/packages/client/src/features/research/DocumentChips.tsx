// The documents attached to a run, shown under its question
// (`09-research-document-view.md` §7).
//
// A chip names the file and opens it. The artifact preview panel is Phase 7
// (`11-artifacts-and-browser.md`), so until it exists a click mints a
// single-document token and opens the artifact origin in a new tab — the same
// URL the panel will frame, so nothing about the call changes when the panel
// lands.
//
// The window is opened before the mint resolves and navigated afterwards: a
// popup opened inside an await is not a user gesture any more, and every
// browser blocks it. That is also why the placeholder is opened without
// `noopener`: `window.open` returns null whenever `noopener` or `noreferrer` is
// in the feature string, and a null handle is a handle this cannot navigate.
// The reverse reference is severed on the handle instead.

import { FileText } from "lucide-react";
import { useState } from "react";

import { mintArtifactToken } from "../../api/api.js";
import { useDocuments } from "../../api/queries.js";

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

  const open = (documentId: string) => {
    const tab = window.open("about:blank", "_blank");
    if (tab) tab.opener = null;
    mintArtifactToken(documentId)
      .then(({ url }) => {
        if (tab) tab.location.href = url;
        else window.open(url, "_blank", "noopener,noreferrer");
        setFailed(null);
      })
      .catch(() => {
        tab?.close();
        setFailed(documentId);
      });
  };

  return (
    <div className="mb-[26px] flex max-w-[min(100%,640px)] flex-wrap gap-1.5">
      {documentIds.map((documentId) => {
        const info = byId.get(documentId);
        return (
          <button
            key={documentId}
            type="button"
            className="border-border-control bg-control text-fg-secondary hover:bg-control-hover focus-visible:ring-focus-ring inline-flex max-w-full items-center gap-1.5 rounded-md border px-2 py-1 text-xs outline-none focus-visible:ring-2"
            title={info ? `${info.name} · open in a new tab` : "Open in a new tab"}
            onClick={() => open(documentId)}
          >
            <FileText size={12} aria-hidden="true" />
            <span className="min-w-0 truncate">{info?.name ?? "Attached document"}</span>
            {info?.extractionStatus === "failed" ? (
              <span className="text-status-failed">text unavailable</span>
            ) : null}
          </button>
        );
      })}
      {failed ? (
        <span className="text-status-failed text-xs" role="alert">
          That document could not be opened.
        </span>
      ) : null}
    </div>
  );
}
