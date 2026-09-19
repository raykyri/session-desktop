// The "system" appearance follows `prefers-color-scheme`. Everything that
// needs a concrete dark/light value (the `data-appearance` attribute, the logo,
// the appearance toggle) resolves through here so the media query is read in
// one place. jsdom has no `matchMedia`; without it the answer is dark.

import type { Appearance } from "@session/shared";
import { useSyncExternalStore } from "react";

export type ResolvedAppearance = Exclude<Appearance, "system">;

const DARK_QUERY = "(prefers-color-scheme: dark)";

function systemPrefersDark(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  return window.matchMedia(DARK_QUERY).matches;
}

export function resolveAppearance(appearance: Appearance): ResolvedAppearance {
  if (appearance !== "system") return appearance;
  return systemPrefersDark() ? "dark" : "light";
}

function subscribeToSystemAppearance(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const query = window.matchMedia(DARK_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** `appearance` resolved against the OS preference, re-rendering when the OS
 * preference changes while "system" is selected. */
export function useResolvedAppearance(appearance: Appearance): ResolvedAppearance {
  const prefersDark = useSyncExternalStore(
    subscribeToSystemAppearance,
    systemPrefersDark,
    () => true,
  );
  if (appearance !== "system") return appearance;
  return prefersDark ? "dark" : "light";
}
