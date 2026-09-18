import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { render, waitFor } from "@testing-library/react";
import type { RenderResult } from "@testing-library/react";
import type { ExecutionContext } from "ava";

import { AppProviders, createAppQueryClient } from "../src/app/providers.js";
import { createAppRouter } from "../src/app/router.js";

/**
 * Mounts the real router on a memory history, so a test drives the same route
 * tree, shell and providers the browser does.
 */
export async function renderApp(initialPath = "/"): Promise<RenderResult> {
  const router = createAppRouter({
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
  const result = render(
    <AppProviders queryClient={createAppQueryClient()}>
      <RouterProvider router={router} />
    </AppProviders>,
  );
  await router.load();
  return result;
}

/**
 * Waits for an asynchronous UI change and asserts it happened.
 *
 * `waitFor` retries until its callback throws nothing, but AVA's assertions do
 * not throw on failure — they record one on `t` and return. So every poll taken
 * before the condition holds leaves a permanent failure behind, and
 * `await waitFor(() => t.is(…))` really means "assert now". Poll on a predicate
 * that throws, and assert exactly once, after it holds.
 */
export async function waitUntil(
  t: ExecutionContext,
  predicate: () => boolean,
  message: string,
): Promise<void> {
  await waitFor(() => {
    if (!predicate()) throw new Error(message);
  });
  t.pass(message);
}

/** Restores `<html>` between tests: `ThemeEffects` writes attributes there, and
 * jsdom keeps one document for the whole worker. */
export function resetDocumentRoot(): void {
  const root = document.documentElement;
  delete root.dataset["colorTheme"];
  delete root.dataset["appearance"];
  delete root.dataset["bodyFont"];
  root.className = "";
  root.removeAttribute("style");
}
