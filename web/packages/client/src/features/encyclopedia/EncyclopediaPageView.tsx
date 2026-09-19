// One encyclopedia page (`10-home-feed-journal-encyclopedia.md` §6, ported from
// `EncyclopediaPageView.tsx`).
//
// The generated body with live wikilinks, so pages can grow pages; a placeholder
// while the model writes; the failure with a Retry; and the passages that asked
// for the page as backlinks. The desktop's adapter/model line is gone — the web
// writes every page with one model (`04-agent-runtime.md` §9) — and the delete
// confirmation is a dialog rather than an inline two-button swap.

import type { EncyclopediaSource } from "@session/shared";
import { useNavigate } from "@tanstack/react-router";
import { CircleAlert, LoaderCircle, RotateCw, Trash2 } from "lucide-react";
import { useState } from "react";

import { deleteEncyclopediaPage, regenerateEncyclopediaPage } from "../../api/api.js";
import { useEncyclopediaPage } from "../../api/queries.js";
import { cn } from "../../lib/cn.js";
import { pushErrorToast } from "../../lib/toast.js";
import { ControlButton, IconButton } from "../../ui/Button.js";
import { ConfirmDialog } from "../../ui/Dialog.js";
import { ResearchMarkdown, WikilinkActionsProvider } from "../markdown/index.js";
import { RESEARCH_COLUMNS_CLASS } from "../research/layout.js";
import { AsyncConfirmDialog } from "../sidebar/dialogs.js";

import { useWikilinkActions } from "./wikilinkActions.js";

const SOURCE_EXCERPT_LIMIT = 220;

export function shortExcerpt(text: string, limit = SOURCE_EXCERPT_LIMIT): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= limit) return collapsed;
  const head = collapsed.slice(0, limit);
  const cut = head.lastIndexOf(" ");
  return `${cut > 0 ? head.slice(0, cut) : head}…`;
}

export function sourceLabel(source: EncyclopediaSource): string {
  if (source.question) return source.question;
  if (source.pageSlug) return "Encyclopedia page";
  return "Research thread";
}

export function EncyclopediaPageView({ workspaceId, slug }: { workspaceId: string; slug: string }) {
  const navigate = useNavigate();
  const query = useEncyclopediaPage(workspaceId, slug);
  const page = query.data ?? null;
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmingRewrite, setConfirmingRewrite] = useState(false);
  // Onward links resolve inside the same workspace, and a page requested from
  // here records this page as its source rather than a research node.
  const actions = useWikilinkActions(workspaceId, { kind: "page", pageSlug: slug });

  const regenerate = () => {
    if (busy) return;
    setBusy(true);
    void regenerateEncyclopediaPage(workspaceId, slug)
      .catch((error: unknown) => pushErrorToast("The page could not be rewritten", error))
      .finally(() => setBusy(false));
  };

  const generating = page?.status === "generating";
  const latestSource = page?.sources.at(-1) ?? null;

  return (
    <div className="research-reading-surface h-full overflow-y-auto px-8 py-8 max-[900px]:px-7">
      {/* The same frame and columns as a thread (09 §3): the page body takes
          the reading column and the rail stays empty, so a page and a thread
          sit on one edge and the body wraps where an answer would. */}
      <div className={cn("research-document-frame", RESEARCH_COLUMNS_CLASS)}>
        <div className="min-w-0 pb-12">
          {query.isError ? (
            <p className="text-status-failed py-6 text-base" role="alert">
              This page could not be loaded.
            </p>
          ) : !page ? (
            <p
              className="text-fg-muted flex items-center gap-2 py-6 text-base"
              role="status"
              aria-live="polite"
            >
              <LoaderCircle size={14} className="session-spin" aria-hidden="true" />
              {query.isLoading ? "Preparing page…" : "This page does not exist."}
            </p>
          ) : (
            <article>
              <header className="flex items-start justify-between gap-3 pb-4">
                <div className="min-w-0">
                  <h1 className="text-fg-heading m-0 text-xl font-semibold">{page.title}</h1>
                  {page.title !== page.term ? (
                    <p className="text-fg-subtle mt-1 mb-0 text-sm">Term: {page.term}</p>
                  ) : null}
                  <p className="text-fg-subtle mt-1 mb-0 flex items-center gap-2 text-sm">
                    {generating ? (
                      <>
                        <LoaderCircle size={12} className="session-spin" aria-hidden="true" />
                        <span>Writing</span>
                      </>
                    ) : page.status === "failed" ? (
                      <>
                        <CircleAlert size={12} className="text-status-failed" aria-hidden="true" />
                        <span>Generation failed</span>
                      </>
                    ) : (
                      <span>Updated {new Date(page.updatedAt).toLocaleString()}</span>
                    )}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <IconButton
                    label="Rewrite page"
                    title="Rewrite page"
                    disabled={generating || busy}
                    onClick={() => setConfirmingRewrite(true)}
                  >
                    <RotateCw size={15} aria-hidden="true" />
                  </IconButton>
                  <IconButton
                    label="Delete page"
                    title="Delete page"
                    onClick={() => setDeleting(true)}
                  >
                    <Trash2 size={15} aria-hidden="true" />
                  </IconButton>
                </div>
              </header>

              {generating ? (
                <div
                  role="status"
                  aria-live="polite"
                  className="text-fg-muted flex flex-col gap-2 text-base"
                >
                  <p className="m-0">
                    Writing this page from{" "}
                    {page.sources.length === 1 ? "one passage" : `${page.sources.length} passages`}…
                  </p>
                  {latestSource ? (
                    <blockquote className="border-border-blockquote text-fg-secondary m-0 border-l-2 pl-3 text-base">
                      {shortExcerpt(latestSource.excerpt, 400)}
                    </blockquote>
                  ) : null}
                </div>
              ) : null}

              {page.status === "failed" ? (
                <div role="alert" className="flex flex-col items-start gap-2 py-2">
                  <p className="text-status-failed m-0 text-base">
                    {page.error ?? "The page could not be written."}
                  </p>
                  <ControlButton size="sm" onClick={regenerate} disabled={busy}>
                    Try again
                  </ControlButton>
                </div>
              ) : null}

              {page.status === "ready" ? (
                <WikilinkActionsProvider actions={actions}>
                  <ResearchMarkdown markdown={page.body} />
                </WikilinkActionsProvider>
              ) : null}

              {page.sources.length > 0 ? (
                <section aria-label="Mentioned in" className="mt-8">
                  <h2 className="text-fg-subtle m-0 text-sm font-normal">Mentioned in</h2>
                  <ul className="mt-2 flex list-none flex-col gap-3 p-0">
                    {[...page.sources].reverse().map((source, index) => (
                      <li
                        key={`${source.nodeId ?? source.pageSlug ?? "src"}-${index}`}
                        className="min-w-0"
                      >
                        <button
                          type="button"
                          disabled={!source.nodeId && !source.pageSlug}
                          className="block max-w-full border-0 bg-transparent p-0 text-left text-base decoration-dotted underline-offset-2 hover:not-disabled:underline disabled:cursor-default"
                          onClick={() => {
                            if (source.nodeId && source.treeId) {
                              void navigate({
                                to: "/r/$treeId",
                                params: { treeId: source.treeId },
                                search: { node: source.nodeId, ws: workspaceId },
                              });
                              return;
                            }
                            if (source.pageSlug) {
                              void navigate({
                                to: "/e/$slug",
                                params: { slug: source.pageSlug },
                                search: { ws: workspaceId },
                              });
                            }
                          }}
                        >
                          <span className="text-fg-interactive block truncate">
                            {sourceLabel(source)}
                          </span>
                          <span className="text-fg-muted block">
                            {shortExcerpt(source.excerpt)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
            </article>
          )}
        </div>
        <div aria-hidden="true" />
      </div>

      <ConfirmDialog
        open={confirmingRewrite}

        onOpenChange={setConfirmingRewrite}

        title="Rewrite this page?"

        description="The current text is replaced by a newly generated page."

        confirmLabel="Rewrite page"

        onConfirm={() => {
          setConfirmingRewrite(false);

          regenerate();
        }}
      />

      <AsyncConfirmDialog
        open={deleting}
        title={page ? `Delete “${page.title}”?` : "Delete page?"}
        description="This page and its backlinks will be deleted. Click the term again to recreate the page."
        confirmLabel="Delete page"
        pendingLabel="Deleting…"
        onOpenChange={setDeleting}
        onConfirm={async () => {
          await deleteEncyclopediaPage(workspaceId, slug);
          void navigate({ to: "/", search: { ws: workspaceId } });
        }}
      />
    </div>
  );
}
