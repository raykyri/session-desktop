import type { DocumentInfo } from "@session/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { listDocuments, removeDocument } from "../../api/api.js";
import { queryKeys } from "../../api/cache.js";
import { errorMessage } from "../../lib/toast.js";
import { ControlButton } from "../../ui/Button.js";
import { ConfirmDialog } from "../../ui/Dialog.js";
import { QueryState } from "../../ui/QueryState.js";
import { formatByteSize } from "../composer/ResearchQueryComposer.js";

/** Account-wide uploads, including files detached from a composer. */
export function DocumentLibrary() {
  const client = useQueryClient();
  const documents = useQuery({
    queryKey: queryKeys.documents(null),
    queryFn: () => listDocuments(),
  });
  const [selected, setSelected] = useState<DocumentInfo | null>(null);
  const removal = useMutation({
    mutationFn: removeDocument,
    onSuccess: async () => {
      setSelected(null);
      await client.invalidateQueries({ queryKey: ["documents"] });
    },
  });

  return (
    <>
      <p className="text-fg-muted m-0 text-base">
        Uploaded documents count toward your storage allowance even after you remove an attachment.
        Delete unused uploads to free space. Documents used in research cannot be deleted.
      </p>
      <QueryState
        loading={documents.isPending}
        error={documents.error ? errorMessage(documents.error) : undefined}
        onRetry={() => {
          void documents.refetch();
        }}
        empty={
          documents.isSuccess && documents.data.length === 0 ? "No uploaded documents." : undefined
        }
      />
      <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Uploaded documents">
        {(documents.data ?? []).map((document) => (
          <li key={document.id} className="flex items-center justify-between gap-3">
            <span>
              {document.name}{" "}
              <span className="text-fg-muted">({formatByteSize(document.byteSize)})</span>
            </span>
            <ControlButton
              size="sm"
              tone="danger"
              aria-label={`Delete ${document.name}`}
              onClick={() => {
                removal.reset();
                setSelected(document);
              }}
            >
              Delete
            </ControlButton>
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open && !removal.isPending) setSelected(null);
        }}
        title="Delete uploaded document?"
        description={
          removal.error
            ? errorMessage(removal.error)
            : `Permanently delete ${selected?.name ?? "this document"}? It may still be attached to a saved draft.`
        }
        confirmLabel="Delete document"
        tone="danger"
        pending={removal.isPending}
        onConfirm={() => {
          if (selected) removal.mutate(selected.id);
        }}
      />
    </>
  );
}
