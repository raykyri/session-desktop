// `@session/sync`: the sync core (AGENTS.md, "Planned: desktop client and
// sync core"). The protocol both halves speak is here; the halves are
// `@session/sync/server` (Node) and `@session/sync/client` (web, desktop
// and React Native: no DOM and no Node APIs), and `@session/sync/react`
// holds the `useQuery` hook.

export * from "./protocol.js";
