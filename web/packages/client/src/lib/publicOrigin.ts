// The app's public origin, from the build (`vite.config.ts` defines
// `__SESSION_PUBLIC_ORIGIN__` from `SESSION_PUBLIC_ORIGIN`). Outside a Vite
// build (tests) and in a build without the variable it is the production
// origin.

declare const __SESSION_PUBLIC_ORIGIN__: string | undefined;

export const PRODUCTION_ORIGIN = "https://session.dev";

export const PUBLIC_ORIGIN: string =
  typeof __SESSION_PUBLIC_ORIGIN__ === "string" && __SESSION_PUBLIC_ORIGIN__ !== ""
    ? __SESSION_PUBLIC_ORIGIN__
    : PRODUCTION_ORIGIN;

/** The abuse mailbox of an origin: `abuse@<hostname>` (02 W2.7, 05 §6 Q10). */
export function abuseAddress(origin: string = PUBLIC_ORIGIN): string {
  return `abuse@${new URL(origin).hostname}`;
}
