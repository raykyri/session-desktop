import { DEFAULT_USER_SETTINGS } from "@session/shared";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { render, waitFor } from "@testing-library/react";
import type { RenderResult } from "@testing-library/react";
import type { ExecutionContext } from "ava";

import {
  adminUsersResource,
  configResource,
  meResource,
  preferencesResource,
  type Me,
} from "../src/api/account.js";
import { setFetch } from "../src/api/http.js";
import { AppProviders } from "../src/app/providers.js";
import { createAppRouter } from "../src/app/router.js";
import { setSessionFactory } from "../src/sync/react.js";
import { SpacesSession } from "../src/sync/session.js";

import { createFetchStub, type Answer, type FetchStub } from "./fetchStub.js";

export function testUser(overrides: Partial<Me> = {}): Me {
  return {
    u: "raymond",
    name: "Raymond",
    bio: "",
    x: "",
    createdAt: "2026-09-15T12:00:00Z",
    id: "u1",
    login: "raymond",
    handle: "raymond",
    avatarUrl: null,
    isAdmin: false,
    ...overrides,
  };
}

/** What the shell reads when it starts. */
export function defaultRoutes(user: Me | null): Record<string, Answer> {
  return {
    "GET /api/me": user ?? new Response(JSON.stringify({ ok: false, error: { code: "UNAUTHORIZED", message: "x" } }), { status: 401 }),
    "GET /api/me/preferences": { ...DEFAULT_USER_SETTINGS, researchLaunchInstruction: null },
    "GET /api/config": { version: "0.0.0", models: [], limits: {}, features: {} },
  };
}

export interface RenderAppOptions {
  /** `null` renders a signed-out guest. */
  user?: Me | null;
  routes?: Record<string, Answer>;
}

export interface RenderAppResult extends RenderResult {
  server: FetchStub;
  router: ReturnType<typeof createAppRouter>;
}

/** Forget the account state a test left (the resources are module state). */
export function resetAccount(): void {
  meResource.reset();
  preferencesResource.reset();
  configResource.reset();
  adminUsersResource.reset();
}

/**
 * Mounts the real router on a memory history, over a recording server: the
 * same route tree, guards, session and providers the browser has.
 */
export async function renderApp(
  initialPath = "/",
  options: RenderAppOptions = {},
): Promise<RenderAppResult> {
  const user = options.user === undefined ? testUser() : options.user;
  const server = createFetchStub({ ...defaultRoutes(user), ...options.routes });
  resetAccount();
  setFetch(server.fetch);
  setSessionFactory((me) => new SpacesSession(me, { fetch: server.fetch, listen: false }));
  // the guards read `/api/me`: load it first, as a warm client has it
  meResource.set(user);
  const router = createAppRouter({
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
  const result = render(
    <AppProviders>
      <RouterProvider router={router} />
    </AppProviders>,
  );
  // a route that throws renders the error panel; the load's rejection is
  // the same error
  await router.load().catch(() => undefined);
  return Object.assign(result, { server, router });
}

/**
 * Waits for an asynchronous UI change and asserts it happened.
 *
 * `waitFor` retries until its callback throws nothing, but AVA's assertions do
 * not throw on failure — they record one on `t` and return. So poll on a
 * predicate that throws, and assert exactly once, after it holds.
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
  delete root.dataset["theme"];
  root.className = "";
  root.removeAttribute("style");
}
