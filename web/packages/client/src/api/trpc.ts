// The tRPC client (07 §1, ADR-3, `03-api-and-events.md` §1).
//
// `AppRouter` is imported as a type and nothing else. `verbatimModuleSyntax`
// erases an `import type` at emit, so the bundle carries no edge from
// `client` to `server` and ADR-1 holds; the ESLint boundary rule has a
// file-scoped exception for this module alone, and `@session/db` stays
// forbidden everywhere.

import type { AppRouter } from "@session/server/router";
import {
  createTRPCClient,
  httpBatchLink,
  httpSubscriptionLink,
  splitLink,
  type TRPCClient,
} from "@trpc/client";

/** Where `createApp` mounts the procedure endpoint (`server/src/app.ts`). */
export const TRPC_ENDPOINT = "/api/trpc";

/** The second CSRF barrier (`06-auth-and-users.md` §5): a cross-origin form
 * or image cannot set a custom header without a preflight we never answer. */
export const REQUESTED_WITH_HEADER = "X-Requested-With";
export const REQUESTED_WITH_VALUE = "session";

export const REQUESTED_WITH_HEADERS: Readonly<Record<string, string>> = {
  [REQUESTED_WITH_HEADER]: REQUESTED_WITH_VALUE,
};

export type SessionTrpcClient = TRPCClient<AppRouter>;

export interface TrpcClientOptions {
  /** Absolute or origin-relative base for the procedure endpoint. */
  url?: string;
  fetch?: typeof globalThis.fetch;
}

/**
 * Queries and mutations go over `httpBatchLink`; `events.subscribe` goes over
 * `httpSubscriptionLink`, which is an `EventSource` and therefore a GET. The
 * subscription carries no `X-Requested-With`: the server guards safe methods
 * by origin alone, and an `EventSource` cannot set a header anyway.
 *
 * The link reconnects on its own with backoff, so the bridge listens for
 * connection-state changes rather than implementing a retry loop
 * (`05-run-lifecycle-and-streaming.md` §4).
 */
export function createSessionTrpcClient(options: TrpcClientOptions = {}): SessionTrpcClient {
  const url = options.url ?? TRPC_ENDPOINT;
  const doFetch = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  return createTRPCClient<AppRouter>({
    links: [
      splitLink({
        condition: (operation) => operation.type === "subscription",
        true: httpSubscriptionLink({ url }),
        false: httpBatchLink({
          url,
          headers: () => REQUESTED_WITH_HEADERS,
          // Same-origin already sends the cookie; stating it means a future
          // absolute `url` (a preview deployment, a test server) keeps the
          // session rather than silently signing the user out.
          fetch: (input, init) => doFetch(input, { ...init, credentials: "include" }),
        }),
      }),
    ],
  });
}

let client: SessionTrpcClient | null = null;

/** The app's client, created on first use so a module import does not open a
 * connection and so tests can install their own first. */
export function trpc(): SessionTrpcClient {
  client ??= createSessionTrpcClient();
  return client;
}

/** Installs a client (a test double, or one pointed at another origin). */
export function setTrpcClient(next: SessionTrpcClient | null): void {
  client = next;
}
