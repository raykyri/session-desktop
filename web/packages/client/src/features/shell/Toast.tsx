// The feed's toast (the mock's `toast`, `.toast`): one line in a dark pill at
// the bottom centre for 4 s; a new toast replaces the shown one. Toasts that
// confirm an action are announced by a `role="status"` region, a refused
// write by a `role="alert"` one (02 §10.1). Both regions stay mounted, empty
// between toasts, so a screen reader is listening before the text arrives.

import { useEffect } from "react";
import { create } from "zustand";

export const TOAST_MS = 4000;

interface ToastState {
  toast: { id: number; text: string; alert: boolean } | null;
}

const useToastStore = create<ToastState>()(() => ({ toast: null }));

let counter = 0;

export function showToast(text: string, options: { alert?: boolean } = {}): void {
  counter += 1;
  useToastStore.setState({ toast: { id: counter, text, alert: options.alert === true } });
}

export function clearToast(): void {
  useToastStore.setState({ toast: null });
}

/** The text of the toast on screen, or null (tests). */
export function currentToast(): string | null {
  return useToastStore.getState().toast?.text ?? null;
}

export function ToastHost() {
  const toast = useToastStore((state) => state.toast);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => {
      if (useToastStore.getState().toast?.id === toast.id) clearToast();
    }, TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);
  const pill = (alert: boolean) =>
    toast && toast.alert === alert ? (
      <div key={toast.id} className="feed-toast">
        {toast.text}
      </div>
    ) : null;
  return (
    <>
      <div role="status" aria-live="polite" data-toast-region="status">
        {pill(false)}
      </div>
      <div role="alert" aria-live="assertive" data-toast-region="alert">
        {pill(true)}
      </div>
    </>
  );
}
