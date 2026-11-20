// The person's header tabs (the mockup's "Edit header tabs" in Account ›
// Your spaces): the order of the spaces the header lists, and the spaces it
// leaves out. A display preference of this browser, kept in localStorage
// (no record of the person's): an empty order is the default order, joined
// spaces first, then the rest, each by activity (`headerSpaces`).

import { useSyncExternalStore } from "react";

export interface HeaderTabs {
  /** Space ids in the order chosen; empty: the default order. */
  order: string[];
  /** Space ids the header does not show. */
  hidden: string[];
}

export const HEADER_TABS_KEY = "session.headerTabs.v1";

const EMPTY: HeaderTabs = { order: [], hidden: [] };

const ids = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

function read(): HeaderTabs {
  try {
    const raw = globalThis.localStorage?.getItem(HEADER_TABS_KEY);
    if (!raw) return EMPTY;
    const v = JSON.parse(raw) as Record<string, unknown>;
    return { order: ids(v["order"]), hidden: ids(v["hidden"]) };
  } catch {
    return EMPTY;
  }
}

let current: HeaderTabs | null = null;
const listeners = new Set<() => void>();

export function headerTabs(): HeaderTabs {
  current ??= read();
  return current;
}

export function setHeaderTabs(next: HeaderTabs): void {
  current = next;
  try {
    globalThis.localStorage?.setItem(HEADER_TABS_KEY, JSON.stringify(next));
  } catch {
    // storage refused (a private window): the choice lasts this tab
  }
  for (const l of [...listeners]) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

export function useHeaderTabs(): HeaderTabs {
  return useSyncExternalStore(subscribe, headerTabs, headerTabs);
}
