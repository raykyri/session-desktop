import { sessionWidgetDownloadDocument } from "@session/shared";
import { useEffect, useRef, useState } from "react";

import { prepareWidgetPreview } from "../../api/api.js";

/** Static-only web boundary: no script or same-origin sandbox permission. */
export function SessionWidget({
  html,
  title,
  nodeId,
}: {
  html: string;
  title: string;
  nodeId: string;
}) {
  const [page, setPage] = useState<{ url: string; expiresAt: number } | null>(null);
  const [source, setSource] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [notice, setNotice] = useState("");
  const [failed, setFailed] = useState(false);
  const loads = useRef(0);
  useEffect(() => {
    let cancelled = false;
    loads.current = 0;
    void prepareWidgetPreview(nodeId, html).then(
      (result) => {
        if (!cancelled) setPage(result);
      },
      () => {
        if (!cancelled) {
          setFailed(true);
          setNotice("Preview unavailable. Retry or inspect the source.");
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [nodeId, html, attempt]);
  useEffect(() => {
    if (!page) return;
    const timer = setTimeout(
      () => {
        setPage(null);
        setFailed(true);
        setNotice("Preview expired. Reload to show it again.");
      },
      Math.max(0, page.expiresAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [page]);
  const buttonClass =
    "rounded px-2 py-1 text-xs hover:bg-surface-hover focus-visible:outline focus-visible:outline-1";
  return (
    <figure
      data-research-widget=""
      className="border-border-subtle my-3 overflow-hidden rounded-md border"
    >
      <figcaption className="border-border-subtle flex flex-wrap items-center gap-1 border-b px-2 py-1">
        <strong className="mr-auto text-sm">{title}</strong>
        <span className="text-fg-muted text-xs">Static preview · scripts off on web</span>
        <button
          type="button"
          className={buttonClass}
          aria-pressed={!source}
          onClick={() => setSource(false)}
        >
          Preview
        </button>
        <button
          type="button"
          className={buttonClass}
          aria-pressed={source}
          onClick={() => setSource(true)}
        >
          Source
        </button>
        <button
          type="button"
          className={buttonClass}
          onClick={() => {
            void navigator.clipboard.writeText(html).then(
              () => setNotice("HTML copied"),
              () => setNotice("Copy failed. Select and copy the source."),
            );
          }}
        >
          Copy
        </button>
        <button
          type="button"
          className={buttonClass}
          onClick={() => {
            // The file carries the static preview's policy (no scripts, no
            // network) as a meta CSP, since it opens outside the sandbox.
            const url = URL.createObjectURL(
              new Blob([sessionWidgetDownloadDocument(html)], { type: "text/html;charset=utf-8" }),
            );
            const link = document.createElement("a");
            link.href = url;
            link.download = "session-widget.html";
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          }}
        >
          Download
        </button>
        <button
          type="button"
          className={buttonClass}
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Collapse" : "Expand"}
        </button>
        <button
          type="button"
          className={buttonClass}
          onClick={() => {
            setPage(null);
            setFailed(false);
            setNotice("");
            setAttempt((value) => value + 1);
          }}
        >
          {failed ? "Retry" : "Reload"}
        </button>
      </figcaption>
      {notice ? (
        <p role="status" className="text-fg-muted px-3 py-1 text-xs">
          {notice}
        </p>
      ) : null}
      {source ? (
        <pre className="max-h-96 overflow-auto p-3 text-xs">
          <code>{html}</code>
        </pre>
      ) : null}
      <div hidden={source}>
        {page ? (
          <iframe
            key={page.url}
            title={title}
            src={page.url}
            sandbox=""
            referrerPolicy="no-referrer"
            className="w-full border-0"
            style={{ height: expanded ? 600 : 300 }}
            onLoad={() => {
              if (++loads.current > 1) {
                setPage(null);
                setFailed(true);
                setNotice("The preview left its page. Reload to show it again.");
              }
            }}
          />
        ) : !failed ? (
          <p role="status" className="text-fg-muted p-4 text-sm">
            Loading preview…
          </p>
        ) : null}
      </div>
    </figure>
  );
}
