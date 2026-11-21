// The suite's client: `@session/sync`'s client half (M2), in the form the
// suite constructs it (a server half and the person it reads for), with the
// `queue` outbox policy the suites drive (3 days, backoff, failure, drop)
// and frozen copies of a person's own threads in a private space they lost.
// The phase 0 client this file held was replaced by `@session/sync/client`;
// its mutation patterns moved there.

import {
  SyncClient,
  type ClientState,
  type RegisterResult as SyncRegisterResult,
} from "@session/sync/client";

import type { Actor, Clock, ServerHalf } from "./contract.js";
import { PROTO_MUTATORS } from "./join-requests.js";

export {
  MAX_SERVER_ERRORS,
  OUTBOX_TTL,
  RETRY_MAX,
  RETRY_MIN,
  type ClientState,
  type Pending,
  type Problem,
  type SyncOutcome,
} from "@session/sync/client";

export class ReplicaClient extends SyncClient {
  constructor(
    server: ServerHalf,
    readonly actor: Actor | null,
    env: { clock: Clock; random: () => number },
    restore?: ClientState,
  ) {
    super(
      {
        // the prototype server answers no lastSeq: 0 for a new id
        register: async (o) =>
          ({
            lastSeq: 0,
            reattached: false,
            ...(await server.register(actor, o)),
          }) as SyncRegisterResult,
        apply: (e) => server.apply(actor, e),
        snapshot: (log, o) => server.snapshot(actor, log, o),
        pull: (log, cursor, o) => server.pull(actor, log, cursor, o),
      },
      {
        user: actor?.u ?? null,
        clock: env.clock,
        random: env.random,
        mutators: PROTO_MUTATORS,
        policy: "queue",
        frozenCopies: true,
        ...(restore ? { restore } : {}),
      },
    );
  }
}
