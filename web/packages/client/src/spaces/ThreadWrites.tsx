// A thread's writes (phase 2b, slice 2): like, save, share, ask about an
// answer, reply, and the run controls (Stop, Run again, Retry). Each write
// goes through the outbox and shows at once; a refusal puts it back with a
// toast. A follow-up or reply that got no answer keeps its text and offers
// Retry (the mockup's as-perr).

import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { isClosed, spaceName } from "../data/format.js";
import type { Space, ThreadView } from "../data/spaces.js";
import { useSession, useStatus } from "../sync/react.js";

import { ModelMenu, PayerLine } from "./Composer.js";
import { DiscardDialog, LeaveGuard } from "./Discard.js";
import { Modal } from "./Page.js";
import { Scrim } from "./Scrim.js";
import { Svg } from "./Svg.js";
import { CI, I, SVG } from "./icons.js";
import { useOverlay } from "./overlay.js";
import { useWorld } from "./world.js";
import { WRITE_ERROR, toast, useQuickWrite, useWrite } from "./writes.js";

const AS_ERR = "Couldn’t post. Try again.";

/** Signed out, an action goes to the sign-in page and back. */
function useSignedIn(): () => boolean {
  const w = useWorld();
  const navigate = useNavigate();
  return () => {
    if (w.me) return true;
    void navigate({ to: "/login", search: { redirect: location.pathname + location.search } });
    return false;
  };
}

export function threadUrl(space: Space, id: string): string {
  return `${location.origin}/s/${space.name}/t/${id}`;
}

async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // the clipboard can be denied (an insecure origin, no focus): the link
    // is still in the dialog's field
  }
}

export function LikeButton({ t }: { t: ThreadView }) {
  const quick = useQuickWrite();
  const signedIn = useSignedIn();
  return (
    <button
      className="act"
      type="button"
      data-toggle="liked"
      aria-pressed={t.liked}
      aria-label="Like"
      onClick={() => {
        if (signedIn()) quick("likes.set", { thread: t.id, on: !t.liked });
      }}
    >
      <Svg src={I.heart} />
      <span className="num">{t.likes}</span>
    </button>
  );
}

export function SaveButton({ t }: { t: ThreadView }) {
  const quick = useQuickWrite();
  const signedIn = useSignedIn();
  return (
    <button
      className="act"
      type="button"
      data-toggle="saved"
      aria-pressed={t.saved}
      aria-label={t.saved ? "Remove from saved" : "Save"}
      title={t.saved ? "Saved" : "Save"}
      onClick={() => {
        if (signedIn()) quick("saved.set", { kind: "thread", id: t.id, on: !t.saved });
      }}
    >
      <Svg src={I.mark} />
    </button>
  );
}

/** Save one ask of the tree ("r": the thread's ask). */
export function SaveAskButton({
  thread,
  node,
  saved,
}: {
  thread: string;
  node: string;
  saved: boolean;
}) {
  const quick = useQuickWrite();
  const signedIn = useSignedIn();
  return (
    <button
      className="act sf-im qt-save"
      type="button"
      aria-pressed={saved}
      aria-label={saved ? "Saved" : "Save this ask"}
      title={saved ? "Saved" : "Save this ask"}
      onClick={() => {
        if (signedIn()) quick("saved.set", { kind: "ask", id: `${thread}:${node}`, on: !saved });
      }}
    >
      <Svg src={I.mark} />
    </button>
  );
}

export function ReplyLike({ id, likes, liked }: { id: string; likes: number; liked: boolean }) {
  const quick = useQuickWrite();
  const signedIn = useSignedIn();
  return (
    <button
      className="tlink ta-like"
      type="button"
      aria-pressed={liked}
      aria-label={`Like (${likes} ${likes === 1 ? "like" : "likes"})`}
      onClick={() => {
        if (signedIn()) quick("likes.setReply", { reply: id, on: !liked });
      }}
    >
      <Svg src={I.heart} />
      <span className="num">{likes}</span>
    </button>
  );
}

/** Share: a menu (Copy link, Share to X) in an open space; in a closed
 * space, a dialog with the link and who can open it. */
export function Share({ t, space }: { t: ThreadView; space: Space }) {
  const [open, setOpen] = useState(false);
  useOverlay(open && !isClosed(space), () => setOpen(false));
  const url = threadUrl(space, t.id);
  const button = (
    <button
      className="act"
      type="button"
      aria-haspopup="true"
      aria-expanded={open}
      aria-label="Share"
      onClick={() => setOpen((o) => !o)}
    >
      <Svg src={CI.share} />
      <span>Share</span>
    </button>
  );
  if (isClosed(space))
    return (
      <>
        {button}
        {open ? (
          <Modal
            title="Share this thread"
            onClose={() => setOpen(false)}
            footer={
              <>
                <span style={{ flex: 1 }} />
                <button className="btn" type="button" onClick={() => setOpen(false)}>
                  Done
                </button>
              </>
            }
          >
            <div className="cs-url">
              <input
                type="text"
                readOnly
                value={url.replace(/^https?:\/\//, "")}
                aria-label="Thread link"
              />
              <button
                className="btn"
                type="button"
                onClick={() => void copy(url).then(() => toast("Link copied."))}
              >
                Copy link
              </button>
            </div>
            <p className="cs-fine">
              <Svg src={SVG.LOCK} />
              <span>
                Only members of {spaceName(space)} can open this link. Other people see{" "}
                {space.vis === "unlisted" ? "a “not available” page" : "the space's join page"}.
              </span>
            </p>
          </Modal>
        ) : null}
      </>
    );
  return (
    <span className="sf-imw ta-shw">
      {button}
      {open ? (
        <>
          <Scrim onClose={() => setOpen(false)} />
          <div className="pop cs-pop sf-ipop ta-shpop" role="menu">
            <button
              className="um-item"
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                void copy(url).then(() => toast("Link copied."));
              }}
            >
              <Svg src={CI.link} />
              <span>Copy link</span>
            </button>
            <button
              className="um-item"
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                window.open(
                  `https://x.com/intent/post?url=${encodeURIComponent(url)}`,
                  "_blank",
                  "noopener",
                );
                toast("Opened X with a link to the thread.");
              }}
            >
              <Svg src={SVG.XI} />
              <span>Share to X</span>
            </button>
          </div>
        </>
      ) : null}
    </span>
  );
}

/** The run controls: Stop while it runs, Run again or Retry after. They are
 * online-only calls (`research.cancelNode`, `research.retryNode`). */
export function useRunControl(thread: string, node: string) {
  const write = useWrite();
  const [busy, setBusy] = useState(false);
  const go = async (name: string, input: unknown) => {
    setBusy(true);
    const o = await write(name, input);
    setBusy(false);
    if (!o.ok && o.error === null) toast(WRITE_ERROR["unavailable"] ?? "");
  };
  return {
    busy,
    stop: () => void go("research.cancelNode", { thread, node }),
    again: () => void go("research.retryNode", { thread, node }),
  };
}

/** Ask about an answer (the mockup's qt-comp): the question, the model, who
 * pays, Cancel and Ask. `par` is "r" (the thread's answer) or a follow-up. */
export function AskBox({
  t,
  par,
  level,
  onClose,
}: {
  t: ThreadView;
  par: string;
  level: number;
  onClose: () => void;
}) {
  const session = useSession();
  const write = useWrite();
  const [draft, setDraft] = useState("");
  const [model, setModel] = useState("");
  const [pay, setPay] = useState("session");
  const [err, setErr] = useState<{ text: string; local: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ta.current?.focus(), []);
  const cancel = () => {
    if (draft.trim()) setConfirm(true);
    else onClose();
  };
  const ask = async () => {
    const q = draft.trim();
    if (!q) {
      setErr({ text: "Write a question first.", local: null });
      ta.current?.focus();
      return;
    }
    setBusy(true);
    const o = await write("research.forkNode", {
      id: session?.newId() ?? "",
      thread: t.id,
      parent: par,
      q,
      pay,
      ...(model ? { model } : {}),
    });
    setBusy(false);
    if (o.ok) onClose();
    else if (o.error === null) setErr({ text: AS_ERR, local: o.local });
  };
  const retry = async (local: string) => {
    setBusy(true);
    const o = await write.retry(local);
    setBusy(false);
    if (o.ok) onClose();
  };
  return (
    <div className="qt-comp" id="qt-comp">
      <textarea
        id="qt-in"
        ref={ta}
        rows={2}
        placeholder="Ask about this answer…"
        aria-label={`Ask about the answer to ${par === "r" ? "the question" : `level ${level}`}`}
        value={draft}
        onChange={(e) => {
          setDraft(e.currentTarget.value);
          setErr(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape" && !confirm) {
            e.stopPropagation();
            cancel();
          }
        }}
      />
      {err ? (
        <span className="qt-err" role="alert">
          {err.text}
          {err.local ? (
            <>
              {" "}
              <button className="tlink" type="button" onClick={() => void retry(err.local ?? "")}>
                Retry
              </button>
            </>
          ) : null}
        </span>
      ) : (
        <PayerLine pay={pay} setPay={setPay} />
      )}
      <div className="qt-cbar fu2-bar">
        <ModelMenu model={model} setModel={setModel} />
        <span className="grow" />
        <button className="btn" type="button" onClick={cancel}>
          Cancel
        </button>
        <button
          className="btn primary"
          type="button"
          disabled={busy}
          aria-disabled={busy || undefined}
          onClick={() => void ask()}
        >
          Ask
        </button>
      </div>
      <LeaveGuard when={!!draft.trim() && !confirm} title="Discard your follow-up?" />
      {confirm ? (
        <DiscardDialog
          title="Discard your follow-up?"
          onKeep={() => setConfirm(false)}
          onDiscard={() => {
            setConfirm(false);
            onClose();
          }}
        />
      ) : null}
    </div>
  );
}

/** Reply to a post (`fu-box2`), or to one of its replies (`ta-rpbox`, with
 * Cancel). */
export function ReplyBox({
  t,
  to,
  onClose,
}: {
  t: ThreadView;
  to?: { id: string; u: string };
  onClose?: () => void;
}) {
  const session = useSession();
  const write = useWrite();
  const signedIn = useSignedIn();
  const [draft, setDraft] = useState("");
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (to) ta.current?.focus();
  }, [to]);
  const send = async () => {
    const text = draft.trim();
    if (!text) {
      ta.current?.focus();
      return;
    }
    if (!signedIn()) return;
    setBusy(true);
    const o = await write("research.createPostFollowUp", {
      id: session?.newId() ?? "",
      thread: t.id,
      t: text,
      ...(to ? { parent: to.id } : {}),
    });
    setBusy(false);
    if (o.ok) {
      setDraft("");
      onClose?.();
    } else if (o.error === null) setFailed(o.local);
  };
  const retry = async () => {
    if (!failed) return;
    setBusy(true);
    const o = await write.retry(failed);
    setBusy(false);
    if (o.ok) {
      setFailed(null);
      setDraft("");
      onClose?.();
    }
  };
  const online = useStatus().online;
  const label = to ? `Reply to ${to.u}` : "Write a reply";
  return (
    <div className={to ? "fu-box2 ta-rpbox" : "fu-box2"}>
      <textarea
        id={to ? "ta-rp" : "fu-input"}
        ref={ta}
        rows={2}
        placeholder={to ? `Reply to ${to.u}…` : "Write a reply…"}
        aria-label={label}
        value={draft}
        onChange={(e) => {
          setDraft(e.currentTarget.value);
          setFailed(null);
        }}
      />
      {failed ? (
        <span className="c2-note warn as-perr" role="alert">
          {online ? AS_ERR : "You’re offline. Your reply wasn’t sent; the text is still here."}{" "}
          <button className="tlink" type="button" onClick={() => void retry()}>
            {online ? "Retry" : "Try again"}
          </button>
        </span>
      ) : null}
      <div className="fu2-bar">
        <span className="grow" />
        {to ? (
          <button
            className="btn"
            type="button"
            onClick={() => (draft.trim() ? setConfirm(true) : onClose?.())}
          >
            Cancel
          </button>
        ) : null}
        <button
          className="btn primary"
          type="button"
          disabled={busy}
          aria-disabled={busy || undefined}
          onClick={() => void send()}
        >
          Reply
        </button>
      </div>
      <LeaveGuard when={!!draft.trim() && !confirm} title="Discard your reply?" />
      {confirm ? (
        <DiscardDialog
          title="Discard your reply?"
          onKeep={() => setConfirm(false)}
          onDiscard={() => {
            setConfirm(false);
            setDraft("");
            onClose?.();
          }}
        />
      ) : null}
    </div>
  );
}
