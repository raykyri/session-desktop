/** Thrown by every module in `api/` until the tRPC client and the SSE bridge
 * land in the second half of Phase 5. The shapes the stubs declare are the
 * contract the client is written against (`03-api-and-events.md`); only the
 * transport is missing, so the routes, stores and primitives compile and render
 * today and the wiring is a body swap rather than a redesign.
 *
 * The call's input rides along as the error's `cause`, so a stub reached by
 * accident says what it was asked to do, not just that it was asked. */
export function notWired(operation: string, input?: unknown): never {
  throw new Error(`${operation} is not wired: the tRPC client arrives with the API transport.`, {
    cause: input,
  });
}
