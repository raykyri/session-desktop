import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Copy, ExternalLink, LogOut } from "lucide-react";
import type { GithubAccount, GithubDeviceLogin } from "../types";
import {
  cancelGithubLogin,
  getGithubAccount,
  logoutGithub,
  openExternalUrl,
  pollGithubLogin,
  startGithubLogin,
} from "../lib/api";
import { writeClipboardText } from "../lib/clipboard";

type LoginState =
  | { phase: "starting" }
  | { phase: "waiting"; device: GithubDeviceLogin }
  | { phase: "error"; message: string };

function errorMessage(error: unknown) {
  if (typeof error === "string") {
    return error;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "GitHub sign-in failed.";
}

/** GitHub's brand mark. lucide dropped brand icons, so this is inlined. */
function GithubMark({ size = 13 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

/**
 * Sidebar account control beneath the folder switcher. Signed out it is a
 * single "Login to GitHub" action; signed in it shows the avatar, display name
 * and login, and opens a small menu with profile/log-out actions. Sign-in runs
 * the OAuth device flow: the backend holds the device code and token, this
 * component only shows the user code and polls for completion.
 */
export default function GithubAccountControl() {
  const [account, setAccount] = useState<GithubAccount | null | undefined>(undefined);
  const [menuOpen, setMenuOpen] = useState(false);
  const [login, setLogin] = useState<LoginState | null>(null);
  const [codeCopied, setCodeCopied] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  // Bumped whenever a login attempt is cancelled or superseded so an in-flight
  // poll chain from the previous attempt stops applying its results.
  const loginAttemptRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    getGithubAccount()
      .then((stored) => {
        if (!cancelled) {
          setAccount(stored);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAccount(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!menuOpen) {
      return;
    }
    function onPointerDown(event: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setMenuOpen(false);
      }
    }
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  const beginLogin = useCallback(() => {
    const attempt = ++loginAttemptRef.current;
    setCodeCopied(false);
    setLogin({ phase: "starting" });
    startGithubLogin()
      .then((device) => {
        if (loginAttemptRef.current !== attempt) {
          return;
        }
        setLogin({ phase: "waiting", device });
        void openExternalUrl(device.verificationUri).catch(() => {});
      })
      .catch((error) => {
        if (loginAttemptRef.current !== attempt) {
          return;
        }
        setLogin({ phase: "error", message: errorMessage(error) });
      });
  }, []);

  const endLogin = useCallback(() => {
    loginAttemptRef.current += 1;
    setLogin(null);
    void cancelGithubLogin().catch(() => {});
  }, []);

  // Poll on GitHub's interval while a device code is outstanding.
  useEffect(() => {
    if (login?.phase !== "waiting") {
      return;
    }
    const attempt = loginAttemptRef.current;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    let intervalSecs = login.device.intervalSecs;

    function schedule() {
      timer = setTimeout(() => {
        void pollGithubLogin()
          .then((result) => {
            if (stopped || loginAttemptRef.current !== attempt) {
              return;
            }
            switch (result.status) {
              case "pending":
                intervalSecs = result.intervalSecs;
                schedule();
                return;
              case "complete":
                setAccount(result.account);
                setLogin(null);
                return;
              case "expired":
                setLogin({
                  phase: "error",
                  message: "The code expired before it was entered. Start again to get a new code.",
                });
                return;
              case "denied":
                setLogin({
                  phase: "error",
                  message: "GitHub reported that the sign-in request was denied.",
                });
                return;
            }
          })
          .catch((error) => {
            if (stopped || loginAttemptRef.current !== attempt) {
              return;
            }
            setLogin({ phase: "error", message: errorMessage(error) });
          });
      }, Math.max(1, intervalSecs) * 1000);
    }
    schedule();
    return () => {
      stopped = true;
      if (timer !== null) {
        clearTimeout(timer);
      }
    };
    // `login.device` is stable for one attempt; the attempt counter guards reuse.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [login?.phase]);

  useEffect(() => {
    if (!login) {
      return;
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        endLogin();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [login, endLogin]);

  function copyCode(code: string) {
    void writeClipboardText(code)
      .then(() => setCodeCopied(true))
      .catch(() => setCodeCopied(false));
  }

  function logout() {
    setMenuOpen(false);
    void logoutGithub()
      .then(() => setAccount(null))
      .catch(() => {});
  }

  const dialog = login
    ? createPortal(
        <div
          className="confirm-dialog-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              endLogin();
            }
          }}
        >
          <div
            className="confirm-dialog github-login-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="github-login-dialog-title"
          >
            <h2 id="github-login-dialog-title">Login to GitHub</h2>
            {login.phase === "starting" ? (
              <p>Requesting a sign-in code from GitHub…</p>
            ) : null}
            {login.phase === "waiting" ? (
              <>
                <p>
                  Enter this code at{" "}
                  <button
                    type="button"
                    className="github-login-link"
                    onClick={() => void openExternalUrl(login.device.verificationUri)}
                  >
                    {login.device.verificationUri.replace(/^https:\/\//, "")}
                  </button>{" "}
                  to approve the sign-in. The page was opened in your browser.
                </p>
                <div className="github-login-code-row">
                  <code className="github-login-code" aria-label="Sign-in code">
                    {login.device.userCode}
                  </code>
                  <button
                    type="button"
                    className="control-button github-login-copy"
                    onClick={() => copyCode(login.device.userCode)}
                    title="Copy code"
                  >
                    {codeCopied ? (
                      <Check size={13} aria-hidden="true" />
                    ) : (
                      <Copy size={13} aria-hidden="true" />
                    )}
                    {codeCopied ? "Copied" : "Copy"}
                  </button>
                </div>
                <p className="github-login-status" role="status" aria-live="polite">
                  <span className="github-login-spinner" aria-hidden="true" />
                  Waiting for approval…
                </p>
              </>
            ) : null}
            {login.phase === "error" ? (
              <p className="confirm-dialog-error">{login.message}</p>
            ) : null}
            <div className="confirm-dialog-actions">
              <button className="control-button" type="button" onClick={endLogin}>
                Cancel
              </button>
              {login.phase === "waiting" ? (
                <button
                  className="control-button"
                  type="button"
                  onClick={() => void openExternalUrl(login.device.verificationUri)}
                >
                  <ExternalLink size={13} aria-hidden="true" />
                  Open GitHub
                </button>
              ) : null}
              {login.phase === "error" ? (
                <button className="control-button" type="button" onClick={beginLogin}>
                  Try again
                </button>
              ) : null}
            </div>
          </div>
        </div>,
        document.body,
      )
    : null;

  if (account === undefined) {
    return <div className="sidebar-account" aria-hidden="true" />;
  }

  if (!account) {
    return (
      <div className="sidebar-account" ref={rootRef}>
        <button
          type="button"
          className="control-button research-folder-trigger sidebar-account-trigger is-signed-out"
          onClick={beginLogin}
          disabled={login !== null}
        >
          <GithubMark />
          <span className="sidebar-account-login-label">Login to GitHub</span>
        </button>
        {dialog}
      </div>
    );
  }

  const displayName = account.name ?? account.login;
  return (
    <div className="sidebar-account" ref={rootRef}>
      <button
        type="button"
        className="control-button research-folder-trigger sidebar-account-trigger"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        title={`Signed in to GitHub as ${account.login}`}
        onClick={() => setMenuOpen((current) => !current)}
      >
        <img
          className="sidebar-account-avatar"
          src={account.avatarUrl}
          alt=""
          width={22}
          height={22}
          draggable={false}
        />
        <span className="research-folder-trigger-copy">
          <span className="research-folder-trigger-name">{displayName}</span>
          <span className="research-folder-path">{account.login}</span>
        </span>
        <ChevronDown size={13} aria-hidden="true" className={menuOpen ? "is-open" : undefined} />
      </button>
      {menuOpen ? (
        <div className="research-folder-menu" role="menu" aria-label="GitHub account">
          <button
            type="button"
            role="menuitem"
            className="control-button research-folder-item"
            onClick={() => {
              setMenuOpen(false);
              void openExternalUrl(`https://github.com/${account.login}`);
            }}
          >
            <ExternalLink size={13} aria-hidden="true" />
            <span className="research-folder-item-name">Open GitHub profile</span>
          </button>
          <div className="research-folder-menu-separator" role="separator" />
          <button
            type="button"
            role="menuitem"
            className="control-button research-folder-item is-remove"
            onClick={logout}
          >
            <LogOut size={13} aria-hidden="true" />
            <span className="research-folder-item-name">Log out</span>
          </button>
        </div>
      ) : null}
      {dialog}
    </div>
  );
}
