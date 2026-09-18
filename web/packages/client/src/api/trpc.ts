// The tRPC client and its TanStack Query integration (07 §1, ADR-3).
//
// STUB. The real implementation is `createTRPCClient` with an httpBatchLink at
// `/trpc` plus `@trpc/tanstack-react-query`, typed by the server's `AppRouter`.
// Importing that type requires `@session/server` to exist, which ADR-1 forbids
// the client from depending on at runtime — the second half wires it as a
// `import type` against a published router type. Until then this module hands
// out the same call surface and throws on use.

import { notWired } from "./notWired.js";

export interface TrpcClientOptions {
  /** Absolute or origin-relative base for the procedure endpoint. */
  url: string;
}

export interface TrpcClient {
  query: <T>(path: string, input?: unknown) => Promise<T>;
  mutate: <T>(path: string, input?: unknown) => Promise<T>;
}

export function createTrpcClient(options: TrpcClientOptions): TrpcClient {
  return {
    query: (path, input) => notWired(`trpc.query(${options.url}${path})`, input),
    mutate: (path, input) => notWired(`trpc.mutate(${options.url}${path})`, input),
  };
}

export const TRPC_ENDPOINT = "/trpc";
