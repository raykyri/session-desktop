// One shape for the three non-content states a query can be in, so the feed,
// highlights, the answer pane, an encyclopedia page and the usage table all
// say "loading", "nothing here" and "failed" the same way. A spinner is never
// paired with a terminal message: either the data is coming, or it is not.

import { LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../lib/cn.js";

import { ControlButton } from "./Button.js";

export interface QueryStateProps {
  /** The request is in flight and nothing has arrived yet. */
  loading?: boolean;
  /** Shown with a spinner while loading; defaults to "Loading…". */
  loadingLabel?: string;
  /** The terminal failure to report; a Retry sits beside it when `onRetry` is given. */
  error?: ReactNode;
  onRetry?: (() => void) | undefined;
  /** The successful-but-empty message. */
  empty?: ReactNode;
  className?: string;
}

export function QueryState({
  loading = false,
  loadingLabel = "Loading…",
  error,
  onRetry,
  empty,
  className,
}: QueryStateProps) {
  if (error) {
    return (
      <div className={cn("flex flex-wrap items-center gap-2 py-4", className)} role="alert">
        <p className="text-status-failed m-0 text-base">{error}</p>
        {onRetry ? (
          <ControlButton size="sm" onClick={onRetry}>
            Retry
          </ControlButton>
        ) : null}
      </div>
    );
  }
  if (loading) {
    return (
      <p
        className={cn("text-fg-muted m-0 flex items-center gap-2 py-4 text-base", className)}
        role="status"
        aria-live="polite"
      >
        <LoaderCircle size={14} className="session-spin" aria-hidden="true" />
        {loadingLabel}
      </p>
    );
  }
  if (empty) {
    return <p className={cn("text-fg-muted m-0 py-4 text-base", className)}>{empty}</p>;
  }
  return null;
}
