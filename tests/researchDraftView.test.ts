import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ResearchDraftView from "../src/components/research/ResearchDraftView";
import { ResearchFeedToast } from "../src/components/research/ResearchFeedChrome";

const noop = () => {};
const asyncNoop = async () => {};

test("a draft opens in the content column with its header, field, and Send", () => {
  const html = renderToStaticMarkup(
    createElement(ResearchDraftView, {
      draft: { id: "d1", workspaceId: "ws", prompt: "An unsent draft", createdAt: 1, updatedAt: 1 },
      requireCmdEnterToSend: true,
      onSave: asyncNoop,
      onSend: asyncNoop,
      onDelete: noop,
      onClose: noop,
    }),
  );
  assert.match(html, /<h2 class="research-column-title is-one-line research-draft-view-title"[^>]*>.*Draft · Not sent<\/h2>/);
  assert.match(html, /aria-label="Delete draft"/);
  assert.match(html, /aria-label="Close"/);
  assert.match(html, /<textarea[^>]*aria-label="Draft question"[^>]*>An unsent draft<\/textarea>/);
  assert.match(html, /type="submit"[^>]*>Send/);
});

test("the toast's live region stays mounted while no toast shows", () => {
  const props = { onUndo: noop, onDismiss: noop, onPause: noop, onResume: noop };
  const empty = renderToStaticMarkup(createElement(ResearchFeedToast, { toast: null, ...props }));
  assert.match(empty, /^<div class="research-feed-toast-region" role="status" aria-live="polite"><\/div>$/);
  const shown = renderToStaticMarkup(
    createElement(ResearchFeedToast, { toast: { id: 1, message: "Moved.", undo: noop }, ...props }),
  );
  assert.match(shown, /role="status"[^>]*><div class="research-feed-toast">.*Moved\..*Undo/);
});
