import { useEffect, useState } from "react";
import { trustedBrowserUrl } from "../../research-browser/protocol";

interface ResearchBrowserSourceDialogProps {
  open: boolean;
  /** Active trusted server URL, or "" for the bundled view. */
  source: string;
  onClose: () => void;
  /** Receives a validated URL, or "" to restore the bundled view. */
  onChoose: (source: string) => void;
}

const EXAMPLE_URL = "http://127.0.0.1:1421/research-browser.html";

/** Chooses where the Research Browser iframe loads its pages from: the view
 * bundled with qmux, or a local development server the user trusts. */
export default function ResearchBrowserSourceDialog({
  open,
  source,
  onClose,
  onChoose,
}: ResearchBrowserSourceDialogProps) {
  const [draft, setDraft] = useState(source);
  const [error, setError] = useState("");
  useEffect(() => {
    if (open) {
      setDraft(source);
      setError("");
    }
  }, [open, source]);
  if (!open) return null;
  const trimmed = draft.trim();
  const submit = () => {
    try {
      onChoose(trustedBrowserUrl(trimmed));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };
  return (
    <div
      className="confirm-dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <form
        className="confirm-dialog rename-dialog research-browser-source-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="research-browser-source-title"
        onSubmit={(event) => {
          event.preventDefault();
          if (trimmed) submit();
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
      >
        <h2 id="research-browser-source-title">Research Browser source</h2>
        <p>
          Pages load from the view bundled with qmux, or from a local
          development server so you can edit the view while the app runs. Loaded
          code can read and modify your research through the qmux SDK, so only
          point this at a server you trust.
        </p>
        <p className="research-browser-source-current">
          Currently loading{" "}
          {source ? (
            <>
              from <code>{source}</code>
            </>
          ) : (
            "the built-in view"
          )}
          .
        </p>
        <label
          className="confirm-dialog-field-label"
          htmlFor="research-browser-source-url"
        >
          Development server URL
        </label>
        <input
          id="research-browser-source-url"
          className="rename-dialog-input"
          value={draft}
          placeholder={EXAMPLE_URL}
          spellCheck={false}
          autoFocus
          onChange={(event) => {
            setDraft(event.currentTarget.value);
            setError("");
          }}
        />
        <p className="rename-dialog-hint">
          Only http://localhost or http://127.0.0.1 URLs are accepted. Start the
          bundled view's server with <code>npm run dev:research-browser</code>
          and load {EXAMPLE_URL}.
        </p>
        {error ? (
          <p className="confirm-dialog-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="confirm-dialog-actions">
          <button className="control-button" type="button" onClick={onClose}>
            Cancel
          </button>
          {source ? (
            <button
              className="control-button"
              type="button"
              onClick={() => onChoose("")}
            >
              Use built-in view
            </button>
          ) : null}
          <button className="control-button" type="submit" disabled={!trimmed}>
            Load from server
          </button>
        </div>
      </form>
    </div>
  );
}
