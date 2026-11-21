// The auth dialog's state (02 W7.2, `authScreen`): which step shows, the
// invite it carries and how it was opened. One store, because the dialog is
// opened from the app bar, from signed-out write controls, from an invite
// link (`/i#<code>`), from the "Invite required" page and, for a waiting
// account holding an open invite, by the shell itself.

import type { Inviter, SignInProvider } from "@session/shared";
import { create } from "zustand";

/**
 * - `landing`: sign in (or, opened from an invite link, the link's answer);
 * - `code`: "Join with invite?", the code field;
 * - `explain`: what the provider shares, then "Continue to X";
 * - `noaccount`: a new identity without an invite ("No Session account");
 * - `profile`: name and handle, which redeems the invite.
 */
export type AuthStep = "landing" | "code" | "explain" | "noaccount" | "profile";

/** An invite link's code and what `auth.checkInvite` said of it. */
export interface LinkInvite {
  code: string;
  state: "checking" | "open" | "unusable";
  inviter: Inviter | null;
}

export interface AuthDialogState {
  open: boolean;
  step: AuthStep;
  /** The invite link this dialog was opened from, while it is shown. */
  link: LinkInvite | null;
  /** The code typed at the code step, and its creator once it checked open. */
  code: string;
  codeInviter: Inviter | null;
  /** The provider of the explain step. */
  provider: SignInProvider;
  /** `signup` when the explain step carries an open code. */
  intent: "signin" | "signup";
  /** The code step redeems for the signed-in waiting account
   * (`accountInvites.redeem`) instead of checking for a sign-up. */
  redeem: boolean;
  /** The invite the profile step redeems, when the dialog knows it. */
  profileInviter: Inviter | null;
  /** Where the dialog was opened from, for its completion toast. */
  origin: "dialog" | "welcome";
  show: (patch: Partial<Omit<AuthDialogState, "show" | "close" | "set">>) => void;
  set: (patch: Partial<Omit<AuthDialogState, "show" | "close" | "set">>) => void;
  close: () => void;
}

const CLOSED = {
  open: false,
  step: "landing" as AuthStep,
  link: null,
  code: "",
  codeInviter: null,
  provider: "x" as SignInProvider,
  intent: "signin" as const,
  redeem: false,
  profileInviter: null,
  origin: "dialog" as const,
};

export const useAuthDialog = create<AuthDialogState>()((set) => ({
  ...CLOSED,
  show: (patch) => set({ ...CLOSED, ...patch, open: true }),
  set: (patch) => set(patch),
  close: () => set({ open: false }),
}));

/** The element focused when the dialog opened, which gets focus back when it
 * closes (02 W7.2). */
let opener: HTMLElement | null = null;

/** Opens the dialog at a step, from anywhere. */
export function openAuthDialog(
  patch: Partial<Omit<AuthDialogState, "show" | "close" | "set">> = {},
): void {
  if (!useAuthDialog.getState().open && typeof document !== "undefined") {
    const active = document.activeElement;
    opener = active instanceof HTMLElement && active !== document.body ? active : null;
  }
  useAuthDialog.getState().show(patch);
}

/** The opener, once: the dialog hands focus back to it as it closes. */
export function takeOpener(): HTMLElement | null {
  const element = opener;
  opener = null;
  return element;
}
