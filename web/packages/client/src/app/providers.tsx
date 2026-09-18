import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import type { ReactNode } from "react";

import { queryClientDefaults } from "../api/queries.js";
import { TooltipProvider } from "../ui/Tooltip.js";

import { ThemeEffects } from "./ThemeEffects.js";

export function createAppQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: queryClientDefaults });
}

/**
 * Everything the tree needs above the router (07 §2). The tRPC provider joins
 * this list with the transport in the second half of Phase 5.
 *
 * The query client is created in state rather than at module scope so each
 * mount — every test, and a future multi-root embed — gets its own cache
 * instead of inheriting another run's.
 */
export function AppProviders({
  children,
  queryClient,
}: {
  children: ReactNode;
  queryClient?: QueryClient;
}) {
  const [fallbackClient] = useState(createAppQueryClient);
  return (
    <QueryClientProvider client={queryClient ?? fallbackClient}>
      <TooltipProvider>
        <ThemeEffects />
        {children}
      </TooltipProvider>
    </QueryClientProvider>
  );
}
