// The auth dialog (02 W7.2; the mockup's `authDialog` and `authScreen`):
// sign-in with GitHub or X, the "Join with invite?" steps, the "No Session
// account" step and the profile step that redeems an invite. Every X button
// of the mockup has a GitHub twin with the same wording (decision P1).
//
// Codes are checked with `auth.checkInvite` (signed out) or redeemed with
// `accountInvites.redeem` (a waiting account); used, revoked and unknown
// codes get the one message of `UNUSABLE_INVITE_MESSAGE` (04 I4). The code
// travels to the server in POST bodies only: the sign-in start sends it to
// `/auth/<provider>/start`, never in a URL.

import { Dialog } from "@base-ui/react/dialog";
import type { Inviter, SignInProvider } from "@session/shared";
import { UNUSABLE_INVITE_MESSAGE, isAccountHandle, parseInviteCode } from "@session/shared";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import type { FormEvent, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";

import { useMe } from "../../api/account.js";
import {
  checkHandle,
  checkInvite,
  redeemInvite,
  startSignIn,
  useCreateAccount,
} from "../../api/membership.js";
import { trpcErrorCode } from "../../lib/toast.js";
import { Avatar } from "../../ui/Avatar.js";
import { GitHubMark } from "../../ui/GitHubMark.js";
import { CloseIcon } from "../feed/icons.js";
import { showToast } from "../shell/Toast.js";
import { AgentIcon } from "../shell/icons.js";

import { takeOpener, useAuthDialog, type AuthStep } from "./authDialog.js";

const PROVIDER_NAME: Record<SignInProvider, string> = { x: "X", github: "GitHub" };

/** The order the buttons stand in: the mockup's X first, its GitHub twin
 * under it. */
const PROVIDERS: readonly SignInProvider[] = ["x", "github"];

export const EMPTY_CODE_MESSAGE = "Enter the code from your invite.";
const RATE_MESSAGE = "Too many attempts. Wait a while and try again.";
const NAME_MESSAGE = "Enter a name.";
const HANDLE_MESSAGE = "Handles use 3 to 20 lowercase letters, numbers, dots or underscores.";
const takenMessage = (handle: string) => `@${handle} is taken. Try another.`;

/** A handle to suggest from the provider's username: lower-cased, other
 * characters dropped, cut to 20. */
export function suggestHandle(login: string): string {
  return login
    .toLowerCase()
    .replace(/[^a-z0-9._]/gu, "")
    .slice(0, 20);
}

function XMark({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M9.47 6.77 15.3 0h-1.38L8.86 5.88 4.82 0H.16l6.11 8.9L.16 16h1.38l5.35-6.21L11.17 16h4.66L9.47 6.77Zm-1.9 2.2-.62-.88L2.03 1.04h2.12l3.98 5.7.62.88 5.18 7.41h-2.12L7.57 8.97Z" />
    </svg>
  );
}

function ProviderMark({ provider }: { provider: SignInProvider }) {
  return provider === "x" ? <XMark /> : <GitHubMark size={15} />;
}

function BackIcon() {
  return (
    <svg
      width={12}
      height={12}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M10 3 5 8l5 5" />
    </svg>
  );
}

function InviterCard({ inviter, title }: { inviter: Inviter; title: string }) {
  return (
    <div className="inviter">
      <Avatar handle={inviter.handle ?? inviter.name} />
      <div>
        <b>{title}</b>
        {inviter.handle ? <small>@{inviter.handle}</small> : null}
      </div>
    </div>
  );
}

/** The error message for a failed check or redeem. */
function checkErrorMessage(error: unknown): string {
  return trpcErrorCode(error) === "TOO_MANY_REQUESTS" ? RATE_MESSAGE : UNUSABLE_INVITE_MESSAGE;
}

/** The steps' content; the dialog and the sign-in page both render it. */
export function AuthSteps({ headingId, returnTo }: { headingId: string; returnTo?: string }) {
  const state = useAuthDialog();
  const navigate = useNavigate();
  const href = useRouterState({ select: (s) => s.location.href });
  const me = useMe().data ?? null;
  const root = useRef<HTMLDivElement>(null);

  // Each step starts at its first field, else its heading (02 W7.2).
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const target =
      element.querySelector<HTMLElement>("input") ?? element.querySelector<HTMLElement>("h2");
    target?.focus({ preventScroll: true });
  }, [state.step, state.link?.state, state.codeInviter]);

  const go = (step: AuthStep, patch: Partial<ReturnType<typeof useAuthDialog.getState>> = {}) =>
    state.set({ step, ...patch });

  const back = (to: AuthStep, patch: Partial<ReturnType<typeof useAuthDialog.getState>> = {}) => (
    <button type="button" className="tlink back" onClick={() => go(to, patch)}>
      <BackIcon />
      Back
    </button>
  );

  const providerButtons = (label: (name: string) => string, intent: "signin" | "signup") => (
    <>
      {PROVIDERS.map((provider) => (
        <button
          key={provider}
          type="button"
          className="xbtn"
          onClick={() => go("explain", { provider, intent })}
        >
          <ProviderMark provider={provider} />
          {label(PROVIDER_NAME[provider])}
        </button>
      ))}
    </>
  );

  let body: ReactNode = null;
  const step = state.step;
  const link = state.link;

  if (step === "landing" && link && link.state === "checking") {
    body = (
      <>
        <h2 id={headingId} tabIndex={-1}>
          Explore together.
        </h2>
        <p role="status">Checking your invite…</p>
      </>
    );
  } else if (step === "landing" && link && link.state === "open" && link.inviter) {
    body = (
      <>
        <InviterCard inviter={link.inviter} title={`${link.inviter.name} invited you to Session`} />
        <h2 id={headingId} tabIndex={-1}>
          Explore together.
        </h2>
        <p>Session is a shared workspace for exploring questions, ideas, and artifacts.</p>
        <div className="auth-acts">
          {providerButtons((name) => `Continue with ${name}`, "signup")}
          <button type="button" className="btn2" onClick={() => state.set({ link: null })}>
            I already have an account
          </button>
        </div>
      </>
    );
  } else if (step === "landing" && link) {
    body = (
      <>
        <h2 id={headingId} tabIndex={-1}>
          This invite link no longer works
        </h2>
        <p>It has already been used or was revoked. Ask the person who sent it for a new one.</p>
        <div className="auth-acts">
          {providerButtons((name) => `Sign in with ${name}`, "signin")}
          <button type="button" className="btn2" onClick={() => go("code", { link: null })}>
            I have an invite code
          </button>
        </div>
      </>
    );
  } else if (step === "landing") {
    body = (
      <>
        <span className="brand-lg">
          <span
            aria-hidden="true"
            className="bg-accent-soft text-accent inline-grid size-7 place-items-center rounded-lg"
          >
            <AgentIcon size={16} />
          </span>
          <b>Session</b>
        </span>
        <h2 id={headingId} tabIndex={-1}>
          Explore together.
        </h2>
        <p>Session is a shared workspace for exploring questions, ideas, and artifacts.</p>
        <div className="auth-acts">
          {providerButtons((name) => `Sign in with ${name}`, "signin")}
          <button type="button" className="btn2" onClick={() => go("code")}>
            I have an invite code
          </button>
        </div>
      </>
    );
  } else if (step === "code") {
    body = <CodeStep headingId={headingId} back={state.redeem ? null : back("landing")} />;
  } else if (step === "explain") {
    body = (
      <ExplainStep
        headingId={headingId}
        back={back(state.intent === "signup" && !state.link ? "code" : "landing")}
        returnTo={returnTo ?? href}
      />
    );
  } else if (step === "noaccount") {
    const login = me?.login ?? "";
    body = (
      <>
        <h2 id={headingId} tabIndex={-1}>
          No Session account for @{login}
        </h2>
        <p>
          Session is invite-only. Ask a member for an invite code, then sign up with it. If you
          already have a code, enter it now.
        </p>
        <div className="auth-acts">
          <button
            type="button"
            className="btn1"
            onClick={() => go("code", { redeem: true, codeInviter: null })}
          >
            Enter an invite code
          </button>
          <button
            type="button"
            className="btn2"
            onClick={() => {
              state.close();
              void navigate({ to: "/" });
            }}
          >
            Continue without one
          </button>
        </div>
        <p className="fine">
          Without an invite you can read every open channel, and enter a code later.
        </p>
      </>
    );
  } else {
    body = <ProfileStep headingId={headingId} />;
  }

  return (
    <div ref={root} className="auth-c">
      {body}
    </div>
  );
}

function CodeStep({ headingId, back }: { headingId: string; back: ReactNode }) {
  const state = useAuthDialog();
  const [value, setValue] = useState(state.code);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const inviter = state.codeInviter;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    const typed = value.trim();
    if (typed === "") {
      setError(EMPTY_CODE_MESSAGE);
      state.set({ codeInviter: null });
      return;
    }
    const code = parseInviteCode(typed);
    setPending(true);
    setError(null);
    try {
      // A malformed code is sent all the same: the server answers it as it
      // answers an unknown one, and counts it as a failed check.
      const check = state.redeem
        ? await redeemInvite(code ?? typed)
        : await checkInvite(code ?? typed);
      if (check.status !== "open") {
        setError(UNUSABLE_INVITE_MESSAGE);
        state.set({ codeInviter: null, code: typed });
      } else if (state.redeem) {
        state.set({ step: "profile", profileInviter: check.inviter, code: code ?? typed });
      } else {
        state.set({ codeInviter: check.inviter, code: code ?? typed });
      }
    } catch (failure) {
      setError(checkErrorMessage(failure));
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      {back}
      <h2 id={headingId} tabIndex={-1}>
        Join with invite?
      </h2>
      <p>Paste the code or link a member sent you.</p>
      <form className="code-f" onSubmit={(event) => void submit(event)} noValidate>
        <input
          value={value}
          onChange={(event) => {
            setValue(event.currentTarget.value);
            if (inviter) state.set({ codeInviter: null });
          }}
          placeholder="SESS-XXXX-XX"
          autoComplete="off"
          spellCheck={false}
          aria-label="Invite code"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "auth-code-err" : undefined}
        />
        <button type="submit" className="btn1" disabled={pending}>
          Continue
        </button>
      </form>
      {error ? (
        <p id="auth-code-err" className="ferr" role="alert">
          {error}
        </p>
      ) : null}
      {inviter && !state.redeem ? (
        <>
          <InviterCard inviter={inviter} title={`Invite from ${inviter.name}`} />
          <div className="auth-acts">
            {PROVIDERS.map((provider) => (
              <button
                key={provider}
                type="button"
                className="xbtn"
                onClick={() => state.set({ step: "explain", provider, intent: "signup" })}
              >
                <ProviderMark provider={provider} />
                Sign up with {PROVIDER_NAME[provider]}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </>
  );
}

function ExplainStep({
  headingId,
  back,
  returnTo,
}: {
  headingId: string;
  back: ReactNode;
  returnTo: string;
}) {
  const state = useAuthDialog();
  const name = PROVIDER_NAME[state.provider];
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const code =
    state.intent !== "signup"
      ? null
      : state.link?.state === "open"
        ? state.link.code
        : state.codeInviter
          ? state.code
          : null;
  return (
    <>
      {back}
      <h2 id={headingId} tabIndex={-1}>
        Sign in with {name}
      </h2>
      <p>
        Session uses your name, handle and profile picture from {name} for your profile. It cannot
        post or read your messages.
      </p>
      <p>Use the same account each time you sign in.</p>
      <div className="auth-acts">
        <button
          type="button"
          className="xbtn"
          disabled={pending}
          onClick={() => {
            setPending(true);
            setError(null);
            startSignIn(state.provider, { code, returnTo: safeReturn(returnTo) }).catch(
              (failure: unknown) => {
                setPending(false);
                setError(failure instanceof Error ? failure.message : String(failure));
              },
            );
          }}
        >
          <ProviderMark provider={state.provider} />
          Continue to {name}
        </button>
      </div>
      {error ? (
        <p className="ferr" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}

/** Where to come back to after sign-in: this page, unless it is the sign-in
 * page itself or the invite link. */
function safeReturn(href: string): string | null {
  if (!href.startsWith("/") || href.startsWith("//")) return null;
  if (href === "/i" || href.startsWith("/i?") || href.startsWith("/login")) return null;
  return href;
}

function ProfileStep({ headingId }: { headingId: string }) {
  const state = useAuthDialog();
  const me = useMe().data ?? null;
  const navigate = useNavigate();
  const create = useCreateAccount();
  const [name, setName] = useState(() => me?.name ?? "");
  const [handle, setHandle] = useState(() => suggestHandle(me?.login ?? ""));
  const [error, setError] = useState<string | null>(null);
  const [unusable, setUnusable] = useState(false);
  const inviter = state.profileInviter ?? me?.pendingInvite ?? null;
  const provider = me?.provider ?? "x";

  const checkAvailability = async () => {
    if (!isAccountHandle(handle)) return;
    try {
      const answer = await checkHandle(handle);
      if (!answer.available) setError(takenMessage(handle));
    } catch {
      // The check is advisory; Create account answers for certain.
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (create.isPending) return;
    if (name.trim() === "") return setError(NAME_MESSAGE);
    if (!isAccountHandle(handle)) return setError(HANDLE_MESSAGE);
    setError(null);
    create.mutate(
      { name, handle },
      {
        onSuccess: (result) => {
          const by = result.inviter.name;
          state.close();
          if (state.origin === "welcome") {
            showToast(`You're in. ${by} invited you.`);
            void navigate({ to: "/" });
          } else {
            showToast(`Account created. ${by} invited you.`);
          }
        },
        onError: (failure) => {
          const code = trpcErrorCode(failure);
          if (code === "CONFLICT" && failure.message === UNUSABLE_INVITE_MESSAGE) {
            setUnusable(true);
            setError(UNUSABLE_INVITE_MESSAGE);
          } else if (code === "CONFLICT") {
            setError(takenMessage(handle));
          } else if (code === "TOO_MANY_REQUESTS") {
            setError(RATE_MESSAGE);
          } else {
            setError(failure.message);
          }
        },
      },
    );
  };

  return (
    <>
      <h2 id={headingId} tabIndex={-1}>
        Create your account
      </h2>
      <div className="inviter">
        <Avatar handle={me?.login ?? "?"} />
        <div>
          <b>
            Signed in with {PROVIDER_NAME[provider]} as @{me?.login ?? ""}
          </b>
          {inviter ? <small>Invited by {inviter.name}</small> : null}
        </div>
      </div>
      <form className="pform" onSubmit={submit} noValidate>
        <label>
          Name
          <input
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
            autoComplete="off"
            maxLength={50}
          />
        </label>
        <label>
          Handle on Session
          <span className="hwrap">
            <span aria-hidden="true">@</span>
            <input
              value={handle}
              onChange={(event) => setHandle(event.currentTarget.value.trim().toLowerCase())}
              onBlur={() => void checkAvailability()}
              autoComplete="off"
              spellCheck={false}
              maxLength={20}
              aria-describedby="auth-handle-hint"
            />
          </span>
          <small id="auth-handle-hint">
            Lowercase letters, numbers, dots and underscores; 3 to 20 characters.
          </small>
        </label>
        {error ? (
          <p className="ferr" role="alert">
            {error}
          </p>
        ) : null}
        {unusable ? (
          <button
            type="button"
            className="btn2 wide"
            onClick={() => state.set({ step: "code", redeem: true, codeInviter: null, code: "" })}
          >
            Enter an invite code
          </button>
        ) : (
          <button type="submit" className="btn1 wide" disabled={create.isPending}>
            Create account
          </button>
        )}
      </form>
    </>
  );
}

/** The modal (02 W7.2): "Sign in to Session" with a Close button, a focus
 * trap, focus back on the opener when it closes. */
export function AuthDialog() {
  const open = useAuthDialog((s) => s.open);
  const close = useAuthDialog((s) => s.close);
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
      onOpenChangeComplete={(next) => {
        if (!next) takeOpener()?.focus({ preventScroll: true });
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="auth-scrim" />
        <Dialog.Popup className="authdlg" aria-label="Sign in to Session" finalFocus={false}>
          <Dialog.Close className="ibtn dclose" aria-label="Close">
            <CloseIcon />
          </Dialog.Close>
          <AuthSteps headingId="auth-step-h" />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
