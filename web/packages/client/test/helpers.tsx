import { DEFAULT_USER_SETTINGS, MODEL_REGISTRY, type User } from "@session/shared";
import { QueryClient } from "@tanstack/react-query";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router";
import { render, waitFor } from "@testing-library/react";
import type { RenderResult } from "@testing-library/react";
import type { ExecutionContext } from "ava";
import type { ReactElement } from "react";

import { queryClientDefaults } from "../src/api/account.js";
import { setTrpcClient } from "../src/api/trpc.js";
import { AppProviders } from "../src/app/providers.js";
import { createAppRouter } from "../src/app/router.js";
import { useAuthDialog } from "../src/features/auth/authDialog.js";

import { createTrpcStub, type TrpcStub } from "./trpcStub.js";

/** An active account; its handle is its login unless given. */
export function testUser(overrides: Partial<User> = {}): User {
  const login = overrides.login ?? "raymond";
  return {
    id: "u1",
    login,
    name: "Raymond",
    avatarUrl: null,
    isAdmin: false,
    createdAt: 1_700_000_000_000,
    handle: login,
    displayName: overrides.name ?? "Raymond",
    status: "active",
    provider: "github",
    ...overrides,
  };
}

/** A waiting account: signed in, no invite, no handle (04 §3.1). */
export function waitingTestUser(overrides: Partial<User> = {}): User {
  return testUser({
    login: "new.one",
    handle: null,
    displayName: null,
    status: "waiting",
    ...overrides,
  });
}

/** What the shell reads over tRPC. Every one of them has to answer with
 * something: a query function that resolves `undefined` is an error in
 * TanStack Query, not an empty result. */
export function defaultResponses(user: User | null): Record<string, unknown> {
  return {
    "auth.me": user,
    "auth.logout": { ok: true },
    "settings.get": { ...DEFAULT_USER_SETTINGS },
    "system.runtimeConfig": { version: "0.0.0", models: [], limits: {}, features: {} },
    // The fixture build's site defaults (`fixtureOnlineData`), so a screen
    // reads the same model and effort with or without the server's answer.
    "models.list": testModelListing(),
    "usage.get": testWeeklyUsage(),
    "usage.listRuns": { runs: [], nextCursor: null },
  };
}

/** `models.list` over the registry, with the fixture build's defaults. */
export function testModelListing(
  defaults: { defaultModel?: string; defaultEffort?: string } = {},
): unknown {
  return {
    models: MODEL_REGISTRY.map((m) => ({
      id: m.id,
      label: m.label,
      provider: m.provider,
      payers: m.payers,
      efforts: m.efforts,
    })),
    defaultModel: defaults.defaultModel ?? "claude-fable",
    defaultEffort: defaults.defaultEffort ?? "high",
  };
}

/** `usage.get` for a member with nothing used, billing `pause` and no keys. */
export function testWeeklyUsage(overrides: Record<string, unknown> = {}): unknown {
  return {
    allowance: 2_000_000,
    used: 0,
    resetAt: Date.UTC(2026, 10, 27),
    billing: "pause",
    keys: [],
    ...overrides,
  };
}

export interface RenderAppOptions {
  /** `null` renders a signed-out guest in the public shell. */
  user?: User | null;
  queryClient?: QueryClient;
  responses?: Record<string, unknown>;
  /** Cache writes applied before the router loads. */
  seed?: (client: QueryClient) => void;
}

export interface RenderAppResult extends RenderResult {
  queryClient: QueryClient;
  trpc: TrpcStub;
  router: ReturnType<typeof createAppRouter>;
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
  // The auth dialog's store outlives a test's render.
  useAuthDialog.getState().close();
  const stub = createTrpcStub({ ...defaultResponses(user), ...options.responses });
  setTrpcClient(stub.client);

  // The app's defaults plus `gcTime: Infinity`, which is what keeps a cache
  // out of Node's timer queue: any finite value schedules a five-minute
  // collection per query — and per settled mutation — and AVA waits for it
  // before exiting.
  const queryClient =
    options.queryClient ??
    new QueryClient({
      defaultOptions: {
        queries: { ...queryClientDefaults.queries, gcTime: Number.POSITIVE_INFINITY },
        mutations: { gcTime: Number.POSITIVE_INFINITY },
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
  return Object.assign(result, { queryClient, trpc: stub, router });
}

/**
 * Renders one component under a router of its own, at `path`, so its links
 * resolve without the app's route tree, guards or shell.
 */
export async function renderInRouter(element: ReactElement, path = "/"): Promise<RenderResult> {
  const rootRoute = createRootRoute({ component: () => element });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { gcTime: Number.POSITIVE_INFINITY } },
  });
  const result = render(
    <AppProviders queryClient={queryClient}>
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
