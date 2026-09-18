// A recording stand-in for the tRPC client.
//
// The wrappers in `src/api/api.ts` are thin by design, so what is worth
// asserting about them is the procedure they call and the input they pass.
// A proxy records both without a server, and a test that renames a procedure
// on one side and not the other fails here rather than in production.

import type { SessionEvent } from "@session/shared";

import type { SessionTrpcClient } from "../src/api/trpc.js";

export interface RecordedCall {
  path: string;
  kind: "query" | "mutate";
  input: unknown;
}

export interface SubscriptionObserver {
  onData?: (event: SessionEvent) => void;
  onError?: (error: unknown) => void;
  onStopped?: () => void;
  onComplete?: () => void;
  onConnectionStateChange?: (state: { state: "idle" | "connecting" | "pending" }) => void;
}

export interface TrpcStub {
  client: SessionTrpcClient;
  calls: RecordedCall[];
  /** Result for a path, e.g. `responses.set("auth.me", { id: "u1" })`. */
  responses: Map<string, unknown>;
  /** Pushes an event into every open subscription. */
  emit: (event: SessionEvent) => void;
  connectionState: (state: "idle" | "connecting" | "pending") => void;
  observers: SubscriptionObserver[];
  unsubscribes: number;
}

export function createTrpcStub(responses: Record<string, unknown> = {}): TrpcStub {
  const stub: TrpcStub = {
    client: null as unknown as SessionTrpcClient,
    calls: [],
    responses: new Map(Object.entries(responses)),
    emit: (event) => {
      for (const observer of stub.observers) observer.onData?.(event);
    },
    connectionState: (state) => {
      for (const observer of stub.observers) observer.onConnectionStateChange?.({ state });
    },
    observers: [],
    unsubscribes: 0,
  };

  const node = (path: readonly string[]): unknown =>
    new Proxy(
      {},
      {
        get(_target, property) {
          if (typeof property !== "string") return undefined;
          const name = path.join(".");
          // A procedure path is `<router>.<procedure>`; an operation name is
          // only an operation once one is complete, which is what lets the
          // subscription procedure be called `subscribe`.
          const terminal = path.length >= 2;
          if (terminal && (property === "query" || property === "mutate")) {
            return (input: unknown) => {
              stub.calls.push({ path: name, kind: property, input });
              return Promise.resolve(stub.responses.get(name));
            };
          }
          if (terminal && property === "subscribe") {
            return (input: unknown, observer: SubscriptionObserver) => {
              stub.calls.push({ path: name, kind: "query", input });
              stub.observers.push(observer);
              return {
                unsubscribe: () => {
                  stub.unsubscribes += 1;
                  stub.observers = stub.observers.filter((candidate) => candidate !== observer);
                },
              };
            };
          }
          return node([...path, property]);
        },
      },
    );

  stub.client = node([]) as SessionTrpcClient;
  return stub;
}
