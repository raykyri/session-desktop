import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { probeAgentAdapters } from "../lib/api";
import type { RuntimeConfig } from "../types";

// A focus or visibility change re-probes once the last result is this old.
const STALE_PROBE_MS = 5 * 60 * 1000;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Agent readiness (installed, signed in) for the runtime config's adapters.
 * Probes once the config loads, again when the window regains focus after
 * five minutes, and on request; a probe's adapters replace the config's.
 * Overlapping probes resolve in order: only the latest updates state.
 */
export function useAdapterReadiness(
  config: RuntimeConfig | null,
  setConfig: Dispatch<SetStateAction<RuntimeConfig | null>>,
) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);
  const completedAtRef = useRef(0);

  const refresh = useCallback(
    async (options?: { force?: boolean }) => {
      const request = requestRef.current + 1;
      requestRef.current = request;
      setLoading(true);
      setError(null);
      try {
        const adapters = await probeAgentAdapters({ force: options?.force });
        if (requestRef.current === request) {
          completedAtRef.current = Date.now();
          setConfig((current) => (current ? { ...current, adapters } : current));
        }
        return adapters;
      } catch (err) {
        if (requestRef.current === request) {
          setError(errorMessage(err));
        }
        throw err;
      } finally {
        if (requestRef.current === request) {
          setLoading(false);
        }
      }
    },
    [setConfig],
  );
  /** A forced probe whose failure shows only as `error`. */
  const forceRefresh = useCallback(() => {
    void refresh({ force: true }).catch(() => undefined);
  }, [refresh]);

  useEffect(() => {
    if (!config || completedAtRef.current > 0) {
      return;
    }
    void refresh().catch(() => undefined);
  }, [config, refresh]);

  useEffect(() => {
    const refreshStale = () => {
      if (document.visibilityState === "hidden") {
        return;
      }
      if (Date.now() - completedAtRef.current >= STALE_PROBE_MS) {
        void refresh({ force: true }).catch(() => undefined);
      }
    };
    window.addEventListener("focus", refreshStale);
    document.addEventListener("visibilitychange", refreshStale);
    return () => {
      window.removeEventListener("focus", refreshStale);
      document.removeEventListener("visibilitychange", refreshStale);
    };
  }, [refresh]);

  return { loading, error, setError, refresh, forceRefresh };
}
