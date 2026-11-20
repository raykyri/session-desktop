// Back links (the mockup's NV.from): a screen opened from another says where
// it came from in the history entry's state, and its back link names it and
// goes back there; without one, the link goes Home.

import { useNavigate, useRouterState } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { I } from "./icons.js";
import { Svg } from "./Svg.js";

/** Where a screen was opened from: a label and the address. */
export interface From {
  label: string;
  to: string;
  /** The space whose feed it was opened from, if any. */
  space?: string;
}

/** A history entry's state, as the spaces client sets it. */
export interface NavState {
  from?: From;
  /** Move focus to the screen's heading (a thread opened from a
   * notification). */
  focus?: boolean;
}

export function useNavState(): NavState {
  return useRouterState({ select: (s) => (s.location.state ?? {}) as NavState });
}

function BackIcon() {
  return <Svg src={I.chev} className="bk" />;
}

/** The back button: back to where it was opened from, or `fallback`. */
export function BackButton({
  fallback,
  children,
}: {
  fallback?: { label: ReactNode; go: () => void };
  children?: ReactNode;
}) {
  const { from } = useNavState();
  const navigate = useNavigate();
  if (from)
    return (
      <button
        className="th-back nv-back"
        type="button"
        aria-label={`Back to ${from.label}`}
        onClick={() => void navigate({ to: from.to })}
      >
        <BackIcon />
        <span className="nv-bl">{from.label}</span>
      </button>
    );
  if (!fallback && !children) return null;
  return (
    <button className="th-back nv-back" type="button" onClick={() => fallback?.go()}>
      <BackIcon />
      <span className="nv-bl">{fallback?.label ?? children}</span>
    </button>
  );
}

/** Notifications, Search, Saved, a profile and Account: back to the screen
 * before, else Home. */
export function BackRow() {
  const navigate = useNavigate();
  return (
    <div className="nv-backrow">
      <BackButton fallback={{ label: "Home", go: () => void navigate({ to: "/" }) }} />
    </div>
  );
}
