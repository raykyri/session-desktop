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

import { ControlButton } from "../ui/Button.js";

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

/**
 * Error boundary component displaying the exception message and providing two recovery options: retry route loaders or reload the window.
 */
export function RouteErrorPanel({ error }: { error: unknown }) {
  const router = useRouter();
  const message = error instanceof Error ? error.message : "";
  return (
    <Panel title="Unable to load this page">
      <p className="text-fg-secondary m-0 text-sm">
        {message || "Something went wrong while rendering this page."}
      </p>
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
          Reload the page
        </ControlButton>
      </div>
    </Panel>
  );
}

/** Rendered for unknown URLs or resources that have been deleted. */
export function RouteNotFoundPanel() {
  return (
    <Panel title="Not found">
      <p className="text-fg-secondary m-0 text-sm">This page does not exist, or it was removed.</p>
      <Link to="/" className="text-accent-fg text-sm underline">
        Go to Home
      </Link>
    </Panel>
  );
}
