import { useEffect, useState } from "react";
import { LoaderCircle, RotateCw, Trash2 } from "lucide-react";
import type { EncyclopediaPage, EncyclopediaSource } from "../../types";
import { IS_MAC } from "../../lib/appHelpers";
import {
  TranscriptWikilinkActionsProvider,
  type WikilinkActions,
} from "../TranscriptMarkdown";
import { ResearchDocumentFrame } from "./ResearchDocumentChrome";
import { ResearchMarkdown } from "./ResearchMessage";

export interface EncyclopediaPageViewProps {
  slug: string;
  /** Null while the page is being fetched or created. */
  page: EncyclopediaPage | null;
  error: string | null;
  wikilinkActions: WikilinkActions | null;
  onRegenerate: () => void;
  onDelete: () => void;
  onOpenSource: (source: EncyclopediaSource) => void;
  canGoBack?: boolean;
  canGoForward?: boolean;
  onBack?: () => void;
  onForward?: () => void;
}

const SOURCE_EXCERPT_LIMIT = 220;

function shortExcerpt(text: string, limit = SOURCE_EXCERPT_LIMIT): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= limit) return collapsed;
  const head = collapsed.slice(0, limit);
  const cut = head.lastIndexOf(" ");
  return `${cut > 0 ? head.slice(0, cut) : head}…`;
}

function sourceLabel(source: EncyclopediaSource): string {
  if (source.question) return source.question;
  if (source.pageSlug) return "Encyclopedia page";
  return "Research thread";
}

const ADAPTER_NAMES: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  grok: "Grok",
  openrouter: "OpenRouter",
};

/** "OpenRouter · google/gemini-3.8-flash" from `generatedBy`, or the requesting
 * agent while the first generation is pending. */
function generatorLabel(page: EncyclopediaPage): string {
  if (page.generatedBy) {
    const [adapter, ...rest] = page.generatedBy.split(":");
    const name = ADAPTER_NAMES[adapter] ?? adapter;
    const model = rest.join(":");
    return model ? `${name} · ${model}` : name;
  }
  const name = ADAPTER_NAMES[page.adapter] ?? page.adapter;
  return page.model ? `${name} · ${page.model}` : name;
}

/** One encyclopedia page on the research stage: the generated body with live
 * wikilinks (so pages can spawn pages), a placeholder while the model writes,
 * and the passages that asked for the page as backlinks. */
export default function EncyclopediaPageView({
  slug,
  page,
  error,
  wikilinkActions,
  onRegenerate,
  onDelete,
  onOpenSource,
  canGoBack = false,
  canGoForward = false,
  onBack,
  onForward,
}: EncyclopediaPageViewProps) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  useEffect(() => {
    setConfirmingDelete(false);
  }, [slug]);

  const generating = page?.status === "generating";
  const latestSource = page?.sources[page.sources.length - 1] ?? null;
  const title = page?.title ?? "Encyclopedia";

  return (
    <ResearchDocumentFrame
      title={title}
      canGoBack={canGoBack}
      canGoForward={canGoForward}
      backTitle={`Back (${IS_MAC ? "⌘[" : "Ctrl+["})`}
      forwardTitle={`Forward (${IS_MAC ? "⌘]" : "Ctrl+]"})`}
      onBack={onBack}
      onForward={onForward}
      headerActions={
        page ? (
          <div className="encyclopedia-page-actions">
            {confirmingDelete ? (
              <>
                <span className="encyclopedia-page-confirm">Delete this page?</span>
                <button
                  type="button"
                  className="control-button danger"
                  onClick={() => {
                    setConfirmingDelete(false);
                    onDelete();
                  }}
                >
                  Delete
                </button>
                <button
                  type="button"
                  className="control-button"
                  onClick={() => setConfirmingDelete(false)}
                >
                  Cancel
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="control-button research-history-button"
                  onClick={onRegenerate}
                  disabled={generating}
                  aria-label="Rewrite page"
                  title="Rewrite page"
                >
                  <RotateCw size={16} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="control-button research-history-button"
                  onClick={() => setConfirmingDelete(true)}
                  aria-label="Delete page"
                  title="Delete page"
                >
                  <Trash2 size={16} aria-hidden="true" />
                </button>
              </>
            )}
          </div>
        ) : null
      }
    >
      <div className="research-document-scroll journal-scroll">
        <div
          className="journal-column research-reading-surface encyclopedia-column"
          data-encyclopedia-slug={slug}
        >
          {error ? (
            <div className="journal-empty-container">
              <p className="journal-empty" role="alert">
                {error}
              </p>
            </div>
          ) : !page ? (
            <p className="encyclopedia-page-pending" role="status" aria-live="polite">
              <LoaderCircle size={14} className="is-spinning" aria-hidden="true" />
              Preparing page…
            </p>
          ) : (
            <article className="encyclopedia-page">
              <header className="encyclopedia-page-header">
                <h1 className="encyclopedia-page-title">{page.title}</h1>
                <p className="encyclopedia-page-meta">
                  {page.title !== page.term ? <span>Term: {page.term}</span> : null}
                  <span>{generatorLabel(page)}</span>
                  <span>
                    {generating
                      ? "Writing"
                      : `Updated ${new Date(page.updatedAt).toLocaleString()}`}
                  </span>
                </p>
              </header>
              {generating ? (
                <div className="encyclopedia-page-pending" role="status" aria-live="polite">
                  <p>
                    <LoaderCircle size={14} className="is-spinning" aria-hidden="true" />
                    Writing this page from{" "}
                    {page.sources.length === 1 ? "one passage" : `${page.sources.length} passages`}
                    …
                  </p>
                  {latestSource ? (
                    <blockquote className="encyclopedia-page-source-excerpt">
                      {shortExcerpt(latestSource.excerpt, 400)}
                    </blockquote>
                  ) : null}
                </div>
              ) : null}
              {page.status === "failed" ? (
                <div className="encyclopedia-page-failed" role="alert">
                  <p className="confirm-dialog-error">
                    {page.error ?? "The page could not be written."}
                  </p>
                  <button type="button" className="control-button" onClick={onRegenerate}>
                    Try again
                  </button>
                </div>
              ) : null}
              {page.status === "ready" ? (
                <TranscriptWikilinkActionsProvider actions={wikilinkActions}>
                  <ResearchMarkdown text={page.body} className="encyclopedia-page-body" />
                </TranscriptWikilinkActionsProvider>
              ) : null}
              {page.sources.length > 0 ? (
                <section className="encyclopedia-page-sources" aria-label="Mentioned in">
                  <h2>Mentioned in</h2>
                  <ul>
                    {[...page.sources].reverse().map((source, index) => (
                      <li key={`${source.nodeId ?? source.pageSlug ?? "src"}-${index}`}>
                        <button
                          type="button"
                          className="encyclopedia-source-link"
                          onClick={() => onOpenSource(source)}
                          disabled={!source.nodeId && !source.pageSlug}
                        >
                          {sourceLabel(source)}
                        </button>
                        <span className="encyclopedia-source-excerpt">
                          {shortExcerpt(source.excerpt)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
            </article>
          )}
        </div>
      </div>
    </ResearchDocumentFrame>
  );
}
