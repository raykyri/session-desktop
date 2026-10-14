// The follow-up queue (`followups.*`): questions asked at the end of an
// inline chain while it cannot take one, sent in order as it frees up. It
// replaces the desktop's client-side queue. Step 2.7 of the desktop-parity
// plan adds `ask`, `cancel`, `retry` and `list` here, on
// `repos/followups.ts` in `@session/db`; until then a follow-up on a busy
// inline slot is refused with CONFLICT by `research.forkNode`.

export const followupProcedures = {};
