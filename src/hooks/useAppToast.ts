import { useCallback, useEffect, useRef, useState } from "react";

const APP_TOAST_TIMEOUT_MS = 5000;

interface AppToast {
  message: string;
  tone: "normal" | "warning";
}

/** One transient app-level toast; a new message replaces the shown one and
 * restarts its five-second timeout. `showAppToast` is stable. */
export function useAppToast() {
  const [appToast, setAppToast] = useState<AppToast | null>(null);
  const timerRef = useRef<number | null>(null);
  const showAppToast = useCallback((message: string, tone: AppToast["tone"] = "normal") => {
    setAppToast({ message, tone });
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
    }
    timerRef.current = window.setTimeout(() => {
      setAppToast(null);
      timerRef.current = null;
    }, APP_TOAST_TIMEOUT_MS);
  }, []);
  useEffect(
    () => () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
    },
    [],
  );
  return { appToast, showAppToast };
}
