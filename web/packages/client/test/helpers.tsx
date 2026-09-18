import { DEFAULT_USER_SETTINGS, type User } from "@session/shared";
import { QueryClient } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { render, waitFor } from "@testing-library/react";
import type { RenderResult } from "@testing-library/react";
import type { ExecutionContext } from "ava";

import { queryClientDefaults } from "../src/api/queries.js";
import { setTrpcClient } from "../src/api/trpc.js";
import { AppProviders } from "../src/app/providers.js";
import { createAppRouter } from "../src/app/router.js";

import { createTrpcStub, type TrpcStub } from "./trpcStub.js";

export function testUser(overrides: Partial<User> = {}): User {
  return {
    id: "u1",
    login: "raymond",
    name: "Raymond",
    avatarUrl: null,
    isAdmin: false,
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

/** What the shell's boot loader reads. Every one of them has to answer with
 * something: a query function that resolves `undefined` is an error in
 * TanStack Query, not an empty result. */
export function defaultResponses(user: User | null): Record<string, unknown> {
  return {
    "auth.me": user,
    "settings.get": {
      ...DEFAULT_USER_SETTINGS,
      researchLaunchInstruction: null,
      defaultWorkspaceId: null,
    },
    "system.runtimeConfig": { version: "0.0.0", models: [], limits: {}, features: {} },
    "workspaces.list": [],
    "research.listTrees": [],
    "research.listActivity": [],
    "folders.get": { folders: [], membership: {}, starred: [], collapsed: [] },
    "encyclopedia.listPages": [],
    "events.subscribe": undefined,
  };
}

export interface RenderAppOptions {
  /** `null` renders a signed-out app, which the guard sends to `/login`. */
  user?: User | null;
  queryClient?: QueryClient;
  responses?: Record<string, unknown>;
  /** Cache writes applied before the router loads. */
  seed?: (client: QueryClient) => void;
}

export interface RenderAppResult extends RenderResult {
  queryClient: QueryClient;
  trpc: TrpcStub;
}

/**
 * Mounts the real router on a memory history, so a test drives the same route
 * tree, shell, guard and providers the browser does — over a recording client
 * rather than a socket.
 */
export async function renderApp(
  initialPath = "/",
  options: RenderAppOptions = {},
): Promise<RenderAppResult> {
  const user = options.user === undefined ? testUser() : options.user;
  const stub = createTrpcStub({ ...defaultResponses(user), ...options.responses });
  setTrpcClient(stub.client);

  // The app's defaults plus `gcTime: Infinity`, which is what keeps a cache
  // out of Node's timer queue: any finite value schedules a five-minute
  // collection per query, and AVA waits for it before exiting.
  const queryClient =
    options.queryClient ??
    new QueryClient({
      defaultOptions: {
        queries: { ...queryClientDefaults.queries, gcTime: Number.POSITIVE_INFINITY },
      },
    });
  // The guard reads `auth.me` through the cache; seeding it keeps the first
  // navigation synchronous, as it is on a warm client in the browser.
  queryClient.setQueryData(["me"], user);
  options.seed?.(queryClient);

  const router = createAppRouter({
    queryClient,
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
  const result = render(
    <AppProviders queryClient={queryClient}>
      <RouterProvider router={router} />
    </AppProviders>,
  );
  await router.load();
  return Object.assign(result, { queryClient, trpc: stub });
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
