// Markdown report import (`10-home-feed-journal-encyclopedia.md` §5, ported
// from `ResearchReportImport.tsx`).
//
// The Tauri drag-drop branch and `readResearchReport` are gone: the browser
// hands over a `File`, and `file.text()` is the whole read. One file at a time,
// `.md` only, non-empty, within the same limits the composer applies; the
// dialog asks for the prompt that produced the report, because an imported
// document with no question behind it has nothing to thread follow-ups onto.

import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { estimateTokenCount } from "@session/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Upload } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

import { importResearchReport } from "../../api/api.js";
import { queryKeys } from "../../api/queries.js";
import { errorMessage, pushErrorToast } from "../../lib/toast.js";
import { ControlButton } from "../../ui/Button.js";
import { ConfirmDialogActionButton, Dialog } from "../../ui/Dialog.js";
import { Textarea } from "../../ui/Field.js";
import { CONTROL_BUTTON } from "../../ui/surfaces.js";
import { oversizeRefusal } from "../composer/limits.js";

export interface StagedReport {
  name: string;
  markdown: string;
}

/** Why a chosen file cannot be imported, or null when it can. Pure, so the
 * refusals are testable without a file picker. */
export function reportRefusal(name: string, markdown: string, byteSize: number): string | null {
  if (!/\.md$/i.test(name)) return "Choose a Markdown (.md) report.";
  if (markdown.trim() === "") return "The report is empty.";
  // The picker already knows the file's size, so the ceiling is checked
  // against that rather than against a re-encoding of its text.
  return oversizeRefusal(markdown, "report", byteSize);
}

export function ReportImport({
  workspaceId,
  dropTarget,
}: {
  workspaceId: string;
  dropTarget: RefObject<HTMLElement | null>;
}) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  const [report, setReport] = useState<StagedReport | null>(null);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stage = useCallback((file: File) => {
    void file
      .text()
      .then((markdown) => {
        const refusal = reportRefusal(file.name, markdown, file.size);
        if (refusal) {
          pushErrorToast("That report could not be imported", new Error(refusal));
          return;
        }
        setPrompt("");
        setError(null);
        setReport({ name: file.name, markdown });
      })
      .catch((failure: unknown) => pushErrorToast("That report could not be read", failure));
  }, []);

  // The drop listener is installed once against the column, so it reads the
  // current `stage` through a ref rather than re-binding on every render.
  const stageRef = useRef(stage);
  useEffect(() => {
    stageRef.current = stage;
  }, [stage]);

  // The prompt is the one thing the dialog asks for, so it takes focus when the
  // dialog opens. Done here rather than with `autoFocus`, which fires before
  // the portal is in the document.
  useEffect(() => {
    if (report === null) return;
    const timer = setTimeout(() => promptRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [report]);

  // HTML5 drop on the Home column, so a report can be dropped anywhere on the
  // page rather than onto the button alone.
  useEffect(() => {
    const target = dropTarget.current;
    if (!target) return;
    const onDragOver = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes("Files")) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    };
    const onDrop = (event: DragEvent) => {
      const files = event.dataTransfer?.files;
      if (!files || files.length === 0) return;
      event.preventDefault();
      if (files.length !== 1) {
        pushErrorToast(
          "Import one report at a time",
          new Error("Import one Markdown report at a time."),
        );
        return;
      }
      const file = files[0];
      if (file) stageRef.current(file);
    };
    target.addEventListener("dragover", onDragOver);
    target.addEventListener("drop", onDrop);
    return () => {
      target.removeEventListener("dragover", onDragOver);
      target.removeEventListener("drop", onDrop);
    };
  }, [dropTarget]);

  const close = () => {
    if (busy) return;
    setReport(null);
    setError(null);
  };

  return (
    <>
      <ControlButton
        size="sm"
        className="gap-1.5"
        title="Import a Markdown report"
        onClick={() => inputRef.current?.click()}
      >
        <Upload size={14} aria-hidden="true" />
        <span>Import report</span>
      </ControlButton>
      <input
        ref={inputRef}
        type="file"
        accept=".md,text/markdown"
        hidden
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) stageRef.current(file);
        }}
      />

      <Dialog
        open={report !== null}
        onOpenChange={(open) => {
          if (!open) close();
        }}
        title="Import report"
        description="The prompt that produced this report becomes the thread's question."
        footer={
          <>
            <BaseDialog.Close className={CONTROL_BUTTON} disabled={busy}>
              Cancel
            </BaseDialog.Close>
            <ConfirmDialogActionButton
              pending={busy}
              pendingLabel="Importing…"
              disabled={prompt.trim() === ""}
              onClick={() => {
                if (!report || busy || prompt.trim() === "") return;
                setBusy(true);
                setError(null);
                importResearchReport({
                  markdown: report.markdown,
                  prompt: prompt.trim(),
                  workspaceId,
                })
                  .then((detail) => {
                    setReport(null);
                    void client.invalidateQueries({ queryKey: ["trees"] });
                    void client.invalidateQueries({ queryKey: ["activity"] });
                    client.setQueryData(queryKeys.tree(detail.tree.id), detail);
                    void navigate({
                      to: "/r/$treeId",
                      params: { treeId: detail.tree.id },
                      search: { ws: workspaceId },
                    });
                  })
                  .catch((failure: unknown) => setError(errorMessage(failure)))
                  .finally(() => setBusy(false));
              }}
            >
              Import report
            </ConfirmDialogActionButton>
          </>
        }
      >
        <Textarea
          ref={promptRef}
          rows={3}
          value={prompt}
          disabled={busy}
          aria-label="Prompt that generated this report"
          placeholder="Paste the original research prompt…"
          className="w-full"
          onChange={(event) => setPrompt(event.currentTarget.value)}
        />
        {report ? (
          <p className="text-fg-muted mt-2 mb-0 flex justify-between gap-2 text-xs">
            <span className="min-w-0 truncate">{report.name}</span>
            <span>{estimateTokenCount(report.markdown).toLocaleString()} tokens (estimated)</span>
          </p>
        ) : null}
        {error ? (
          <p className="text-status-failed mt-2 mb-0 text-sm" role="alert">
            {error}
          </p>
        ) : null}
      </Dialog>
    </>
  );
}
