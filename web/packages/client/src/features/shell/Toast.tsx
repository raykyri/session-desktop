// The feed's toast (the mock's `toast`, `.toast`): one line in a dark pill at
// the bottom centre for 4 s; a new toast replaces the shown one. Toasts that
// confirm an action are `role="status"`; a refused write is `role="alert"`
// (02 §10.1).

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
  if (!toast) return null;
  return (
    <div key={toast.id} className="feed-toast" role={toast.alert ? "alert" : "status"}>
      {toast.text}
    </div>
  );
}
