import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { Upload } from "lucide-react";
import { readResearchReport } from "../../lib/api";
import { estimateTokenCount } from "../../lib/tokenEstimate";

export default function ResearchReportImport({ dropTarget, onImport, onError }: {
  dropTarget: RefObject<HTMLDivElement | null>;
  onImport: (markdown: string, prompt: string) => Promise<void>;
  onError: (message: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const occupied = useRef(false);
  const mounted = useRef(true);
  const [report, setReport] = useState<{ name: string; markdown: string } | null>(null);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function stage(name: string, read: () => Promise<string>) {
    if (occupied.current) return;
    if (!/\.md$/i.test(name)) {
      onError("Choose a Markdown (.md) report.");
      return;
    }
    occupied.current = true;
    try {
      const markdown = await read();
      if (!markdown.trim()) throw new Error("The report is empty.");
      if (!mounted.current) return;
      setPrompt("");
      setError(null);
      setReport({ name, markdown });
    } catch (err) {
      occupied.current = false;
      if (mounted.current) onError(String(err));
    }
  }
  const stageRef = useRef(stage);
  stageRef.current = stage;

  useEffect(() => {
    mounted.current = true;
    const target = dropTarget.current;
    if (!target) return;
    const dragOver = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes("Files")) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    };
    const drop = (event: DragEvent) => {
      if (!event.dataTransfer?.files.length) return;
      event.preventDefault();
      const files = event.dataTransfer.files;
      if (files.length !== 1) { onError("Import one Markdown report at a time."); return; }
      const file = files[0];
      void stageRef.current(file.name, () => file.text());
    };
    target.addEventListener("dragover", dragOver);
    target.addEventListener("drop", drop);
    let disposed = false;
    let unlisten: (() => void) | undefined;
    if (isTauri()) {
      void getCurrentWebview().onDragDropEvent(({ payload }) => {
        if (payload.type !== "drop") return;
        const rect = target.getBoundingClientRect();
        const x = payload.position.x / window.devicePixelRatio;
        const y = payload.position.y / window.devicePixelRatio;
        if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return;
        if (payload.paths.length !== 1) { onError("Import one Markdown report at a time."); return; }
        const path = payload.paths[0];
        void stageRef.current(path.split(/[\\/]/).pop() ?? path, () => readResearchReport(path));
      }).then((cleanup) => {
        if (disposed) cleanup(); else unlisten = cleanup;
      }).catch((err) => { if (!disposed) onError(String(err)); });
    }
    return () => {
      mounted.current = false;
      disposed = true;
      unlisten?.();
      target.removeEventListener("dragover", dragOver);
      target.removeEventListener("drop", drop);
    };
  }, [dropTarget, onError]);

  useEffect(() => {
    if (report) dialogRef.current?.showModal();
  }, [report]);

  // Grow the prompt field to fit its committed value. Measuring in onChange can
  // catch WebKit between its native edit and React restoring the controlled
  // value; useLayoutEffect keeps value and height in one pre-paint commit.
  useLayoutEffect(() => {
    const textarea = promptRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [prompt, report]);

  function close() {
    if (busy) return;
    dialogRef.current?.close();
    setReport(null);
    occupied.current = false;
    buttonRef.current?.focus();
  }

  return <>
    <button ref={buttonRef} type="button" className="control-button research-history-button research-header-icon"
      onClick={() => inputRef.current?.click()} aria-label="Import .md report">
      <Upload size={14} className="research-import-icon" aria-hidden="true" />
      <span className="research-header-tooltip" aria-hidden="true">Import .md report</span>
    </button>
    <input ref={inputRef} type="file" accept=".md,text/markdown" hidden onChange={(event) => {
      const file = event.currentTarget.files?.[0];
      event.currentTarget.value = "";
      if (file) void stage(file.name, () => file.text());
    }} />
    {report && createPortal(
      <dialog ref={dialogRef} className="confirm-dialog research-import-dialog"
        aria-labelledby="research-import-title" onCancel={(event) => { event.preventDefault(); close(); }}>
        <form onSubmit={async (event) => {
          event.preventDefault();
          if (busy || !prompt.trim()) return;
          setBusy(true);
          setError(null);
          try {
            await onImport(report.markdown, prompt.trim());
            if (mounted.current) {
              dialogRef.current?.close();
              setReport(null);
              occupied.current = false;
              buttonRef.current?.focus();
            }
          } catch (err) { if (mounted.current) setError(String(err)); }
          finally { if (mounted.current) setBusy(false); }
        }}>
          <h2 id="research-import-title">Import report</h2>
          <label className="confirm-dialog-field-label research-import-field" htmlFor="research-import-prompt">
            <span>Prompt that generated this report</span>
            <textarea ref={promptRef} id="research-import-prompt" className="rename-dialog-input" autoFocus required
              rows={3} value={prompt} disabled={busy} onChange={(event) => setPrompt(event.currentTarget.value)}
              placeholder="Paste the original research prompt…" />
          </label>
          <p className="research-import-file">
            <span className="research-import-filename">{report.name}</span>
            <span className="research-import-tokens">
              {estimateTokenCount(report.markdown).toLocaleString()} tokens (estimated)
            </span>
          </p>
          {error && <p className="confirm-dialog-error" role="alert">{error}</p>}
          <div className="confirm-dialog-actions">
            <button type="button" className="control-button" disabled={busy} onClick={close}>Cancel</button>
            <button type="submit" className="control-button" disabled={busy || !prompt.trim()}>
              {busy ? "Importing…" : "Import report"}
            </button>
          </div>
        </form>
      </dialog>, document.body,
    )}
  </>;
}
