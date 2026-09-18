// The app's `QueryClient`.
//
// It lives in its own module because the router needs it too: the auth guard
// reads `auth.me` through the cache in `beforeLoad`, and the boot loader warms
// the six queries the shell renders from (07 §2). A client created inside a
// component would be invisible to both.

import { QueryClient } from "@tanstack/react-query";

import { queryClientDefaults } from "../api/queries.js";

export function createAppQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: queryClientDefaults });
}

/** The one the browser uses. Tests build their own and pass it to the router
 * and the providers together. */
export const appQueryClient = createAppQueryClient();
