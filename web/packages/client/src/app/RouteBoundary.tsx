// What a route renders when it cannot render itself
// (`07-client-architecture.md` §3).
//
// Without these, a throw anywhere inside a route — a malformed diagram in a
// streamed markdown render, an anchor that no longer resolves — unmounts the
// whole React tree and leaves a blank page with a stack in the console. The
// shell is a layout route, so both components render inside it: the sidebar,
// the stage header and the event subscription survive, and only the pane that
// failed is replaced.

import { Link, useRouter } from "@tanstack/react-router";

import { UPGRADE_MESSAGE } from "../replica/upgrade.js";
import { ControlButton } from "../ui/Button.js";
import { QueryState } from "../ui/QueryState.js";

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section
      role="alert"
      className="mx-auto flex max-w-[46ch] flex-col items-start gap-3 px-6 py-16"
    >
      <h1 className="text-title text-fg-primary m-0 font-medium">{title}</h1>
      {children}
    </section>
  );
}

/** Whether a route failed because a lazily loaded chunk is gone: the tab
 * runs an older build than the server now serves. The browsers word the
 * failed dynamic import differently. */
export function isStaleChunkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  return /dynamically imported module|module script failed/i.test(message);
}

/** The panel's sentence: the upgrade notice's wording when the tab's build is
 * out of date, else one fixed sentence. The exception's own message is never
 * shown. */
export function routeErrorText(error: unknown): string {
  return isStaleChunkError(error)
    ? UPGRADE_MESSAGE
    : "Something went wrong on this page. Try again, or reload the page.";
}

/**
 * Error boundary component with two recovery options: retry route loaders or reload the window.
 */
export function RouteErrorPanel({ error }: { error: unknown }) {
  const router = useRouter();
  return (
    <Panel title="Couldn't load this page">
      <p className="text-fg-secondary m-0 text-sm">{routeErrorText(error)}</p>
      <div className="flex gap-2">
        <ControlButton
          size="sm"
          onClick={() => {
            void router.invalidate();
          }}
        >
          Try again
        </ControlButton>
        <ControlButton size="sm" onClick={() => window.location.reload()}>
          Reload
        </ControlButton>
      </div>
    </Panel>
  );
}

/** What a lazily loaded route shows while its chunk loads: on a first load
 * at once, on a navigation only after the router's `pendingMs` (the previous
 * page stays up until then). */
export function RoutePendingPanel() {
  return (
    <div className="flex h-full items-center justify-center px-6">
      <QueryState loading />
    </div>
  );
}

/** Rendered for unknown URLs or resources that have been deleted. */
export function RouteNotFoundPanel() {
  return (
    <Panel title="Not found">
      <p className="text-fg-secondary m-0 text-sm">
        This page doesn't exist, or you don't have access to it.
      </p>
      <Link to="/" className="text-accent-fg text-sm underline">
        Go to Home
      </Link>
    </Panel>
  );
}
