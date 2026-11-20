// A screen's frame (the mockup's `<div class="A C Af …">`): the header, the
// offline bar, then the screen. And the system states: loading (skeleton
// rows), a load that failed, page not found, Update Session.

import { useNavigate } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { spaceName } from "../data/format.js";
import { isDesktop, platform, siteHost } from "../platform.js";
import { useSession, useStatus } from "../sync/react.js";

import { Header, type Place } from "./Header.js";
import { useOutbox } from "./Outbox.js";
import { Svg } from "./Svg.js";
import { cx } from "./cx.js";
import { I, NVI, SVG } from "./icons.js";
import { focusFirst, useOverlay } from "./overlay.js";
import { useWorld } from "./world.js";
import { toast } from "./writes.js";

/** Offline: the web can't send changes; the Desktop app keeps them on the
 * device (the mockup's sx-off-app) and sends them when the connection is
 * back. */
export function OfflineBar() {
  const status = useStatus();
  const session = useSession();
  if (status.online) return null;
  const here = session?.persistent ? platform().here : null;
  return (
    <div className="nv-off" role="status">
      <Svg src={NVI.off ?? SVG.LOCK} />
      <span className="grow">
        {here
          ? `You’re offline. Changes are saved on ${here} and sent when the connection is back.`
          : "You’re offline. Session shows what it already loaded and can’t send changes until the connection is back."}
      </span>
      <button className="btn sm" type="button" onClick={() => void session?.retry()}>
        Try again
      </button>
    </div>
  );
}

const PLACE_TITLE: Partial<Record<Place["kind"], string>> = {
  home: "Home",
  saved: "Saved",
  notifications: "Notifications",
  search: "Search",
  browse: "Browse spaces",
};

/** The Desktop app's window title names where the person is ("Session —
 * Home", the mockup's sx-wt); the platform puts it in the title bar. The web
 * keeps its page title. */
function useWindowTitle(place: Place) {
  const w = useWorld();
  const space = place.kind === "space" || place.kind === "thread" ? w.byId.get(place.id) : null;
  const where =
    PLACE_TITLE[place.kind] ??
    (space ? spaceName(space) : place.kind === "other" ? place.label : undefined);
  useEffect(() => {
    if (isDesktop()) document.title = where ? `Session — ${where}` : "Session";
  }, [where]);
}

/** A screen: its root classes, the header (where it is), and its body. */
export function Page({
  cls = "H",
  place,
  children,
}: {
  cls?: string;
  place: Place;
  children: ReactNode;
}) {
  useWindowTitle(place);
  return (
    <div className={cx("A C Af", cls)}>
      <Header place={place} />
      <OfflineBar />
      {children}
    </div>
  );
}

/** The first load: skeleton rows under a skeleton header. */
export function Skeleton() {
  const row = (w: string, k: number) => (
    <div className="nv-sk-row" key={k}>
      <span className="nv-sk nv-sk-ic" />
      <span className="nv-sk-tx">
        <span className="nv-sk" style={{ width: w }} />
        <span className="nv-sk nv-sk-s" />
        <span className="nv-sk nv-sk-m" />
      </span>
    </div>
  );
  return (
    <div className="nv-skel" role="status">
      <span className="nv-vh">Loading…</span>
      <div className="nv-sk-hdr" aria-hidden="true">
        <span className="nv-sk nv-sk-logo" />
        <span className="nv-sk nv-sk-tab" />
        <span className="nv-sk nv-sk-tab" />
        <span className="nv-sk nv-sk-tab" />
        <span className="grow" />
        <span className="nv-sk nv-sk-av" />
      </div>
      <div className="nv-sk-body" aria-hidden="true">
        <span className="nv-sk nv-sk-h" />
        {["78%", "62%", "86%", "56%", "72%", "66%"].map(row)}
      </div>
    </div>
  );
}

/** A first load that failed, with Retry (`de-load-auth`). */
export function LoadFailed({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="data-wait" role="alert">
      <p>{message}</p>
      <button className="btn" type="button" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}

/** Page not found: an unknown address, or a space that does not exist. */
export function NotFound({ space }: { space?: string }) {
  const navigate = useNavigate();
  const addr = `${siteHost()}${location.pathname}`;
  return (
    <div className="cs-napage nv-nf">
      <div className="cs-na">
        <span className="cs-na-ic">
          <Svg src={NVI.map} />
        </span>
        <h2>{space !== undefined ? `No space named #${space}` : "Page not found"}</h2>
        <p className="muted">
          {space !== undefined ? (
            "Session has no space at this address. Check the name, or search for the space. If its moderators renamed it, links to the old name stop working."
          ) : (
            <>
              Session has no page at <b>{addr}</b>. Check the address, or search for what you were
              looking for.
            </>
          )}
        </p>
        <div className="cs-na-b">
          <button className="btn primary" type="button" onClick={() => void navigate({ to: "/" })}>
            Go to Home
          </button>
          <button className="btn" type="button" onClick={() => void navigate({ to: "/search" })}>
            Search
          </button>
        </div>
      </div>
    </div>
  );
}

/** A modal dialog in the mockup's markup: Escape and the scrim close it,
 * focus moves in and goes back to its opener. */
export function Modal({
  title,
  onClose,
  children,
  footer,
  className = "cs-m",
  role = "dialog",
  bare = false,
  back = true,
  wrap,
  unsaved,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
  role?: "dialog" | "alertdialog";
  /** A title without the header row and its Close button (the mockup's
   * discard questions). */
  bare?: boolean;
  /** Back closes it (a history entry); off for a dialog that a blocked
   * navigation opened, which goes on once it closes. */
  back?: boolean;
  /** A class for an element around the dialog (the mockup's qt-olm-sheet). */
  wrap?: string;
  /** Unsaved input: Back, Escape, the scrim and Close ask first (the
   * mockup's OV_DIRTY); a Cancel button of the dialog's own discards. */
  unsaved?: { dirty: () => boolean; title: string; body: string };
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [asking, setAsking] = useState(false);
  const leave = (): boolean => {
    if (unsaved?.dirty()) {
      setAsking(true);
      return false;
    }
    onClose();
    return true;
  };
  useOverlay(!asking, leave, { back });
  useEffect(() => focusFirst(ref.current), []);
  // each dialog its own title id: a confirmation stacks on a dialog
  const id = `cs-dt${useId().replace(/:/g, "")}`;
  // a dialog sits at the top of the app element (as the mockup's do), not
  // inside the menu or row that opened it
  const dialog = (
    // a press outside the dialog closes it; Escape does from the keyboard
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div
      className="modal-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) leave();
      }}
    >
      <div
        ref={ref}
        className={`modal ${className}`}
        role={role}
        aria-modal="true"
        aria-labelledby={id}
      >
        {bare ? (
          <h3 id={id}>{title}</h3>
        ) : (
          <div className="modal-h">
            <h3 id={id}>{title}</h3>
            <button className="iconbtn" type="button" aria-label="Close" onClick={() => leave()}>
              <Svg src={I.close} />
            </button>
          </div>
        )}
        {children}
        {footer ? <div className="modal-f">{footer}</div> : null}
      </div>
      {asking && unsaved ? (
        <DiscardDialog
          title={unsaved.title}
          body={unsaved.body}
          onKeep={() => setAsking(false)}
          onDiscard={() => {
            setAsking(false);
            onClose();
          }}
        />
      ) : null}
    </div>
  );
  return createPortal(
    wrap ? <div className={wrap}>{dialog}</div> : dialog,
    document.getElementById("app") ?? document.body,
  );
}

/** Update Session: the server takes this client's writes no more until the
 * page is reloaded. Later closes it; it comes back on the next refused
 * write. */
export function UpdateDialog({ onLater }: { onLater: () => void }) {
  const session = useSession();
  // the Desktop app (the mockup's sx-up-app): the writes wait on the device
  const here = session?.persistent ? platform().here : null;
  const waiting = useOutbox().items.length;
  return (
    <Modal
      title="Update Session"
      onClose={onLater}
      footer={
        <>
          <span style={{ flex: 1 }} />
          <button className="btn" type="button" onClick={onLater}>
            Later
          </button>
          <button
            className="btn primary"
            type="button"
            onClick={() => {
              platform().update();
              if (here) {
                onLater();
                toast(
                  `Opened the download page in your browser. Unsent changes are kept on ${here}.`,
                );
              }
            }}
          >
            {here ? "Download and restart" : "Reload"}
          </button>
        </>
      }
    >
      <p className="muted">
        {here
          ? `This version of Session is too old to sync.${waiting ? ` ${waiting} changes wait on ${here} and are sent after the update.` : ""}`
          : "Session has been updated. Reload the page to keep saving changes."}
      </p>
    </Modal>
  );
}

/** Unsent text: the "Discard …?" question (the mockup's ask-discard and the
 * composer's discard, and OV_DIRTY's questions). */
export function DiscardDialog({
  title,
  body = "The text you wrote will be deleted.",
  onKeep,
  onDiscard,
  back = true,
}: {
  title: string;
  /** What is lost (the mockup's OV_DIRTY text). */
  body?: string;
  onKeep: () => void;
  onDiscard: () => void;
  back?: boolean;
}) {
  return (
    <Modal
      title={title}
      role="alertdialog"
      className="sm"
      bare
      back={back}
      onClose={onKeep}
      footer={
        <>
          <span style={{ flex: 1 }} />
          <button className="btn" type="button" onClick={onKeep}>
            Keep editing
          </button>
          <button className="btn danger" type="button" onClick={onDiscard}>
            Discard
          </button>
        </>
      }
    >
      <p className="muted">{body}</p>
    </Modal>
  );
}
