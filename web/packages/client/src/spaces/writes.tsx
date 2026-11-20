// Writes from the screens (phase 2b, slice 2): a write goes through the sync
// client's outbox (predicted at once, then confirmed or refused). On the web
// (`persist: false`) a write that gets no answer (offline, a server error)
// ends at once: the screen that made it shows Try again on its item. A
// refusal (FORBIDDEN, NOT_FOUND, STALE, …) puts the prediction back and shows
// one toast whose text depends on the code (the mockup's API_ERR.write).

import type { Answer, ApiError } from "@session/sync/client";
import { useState, useSyncExternalStore } from "react";

import { useSession } from "../sync/react.js";
import type { SpacesSession } from "../sync/session.js";

import { Svg } from "./Svg.js";
import { I } from "./icons.js";

export const WRITE_ERROR: Record<string, string> = {
  BAD_REQUEST: "The server rejected the change as not valid. Session undid it.",
  UNAUTHORIZED: "Your sign-in expired, so the server didn’t save the change. Sign in again.",
  FORBIDDEN: "You no longer have permission to do this. Session undid the change.",
  NOT_FOUND: "Someone deleted this item, so the server couldn’t save the change. Session undid it.",
  CONFLICT: "Someone else changed this item first. Session undid your change.",
  PRECONDITION_FAILED:
    "The item changed state, so the server didn’t save the change. Session undid it.",
  TOO_MANY_REQUESTS:
    "You made too many changes in a short time. Session undid the last one. Try again in a minute.",
  STALE:
    "This item changed after you opened it, so the server didn’t apply the change. Session undid it.",
  EXPIRED: "The change was made too long ago for the server to take it. Session undid it.",
  TOO_LARGE: "The change is too large for the server to take. Session undid it.",
  UPDATE_REQUIRED: "This version of Session can’t save changes. Reload to update it.",
  unavailable: "Couldn’t reach the server, so Session undid the change. Try again in a moment.",
};

// ---- toasts ----

interface ToastAction {
  label: string;
  run: () => void;
}

interface Toast {
  id: number;
  text: string;
  actions: ToastAction[];
}

let toasts: Toast[] = [];
let nextToast = 1;
const toastListeners = new Set<() => void>();
const emit = () => {
  for (const l of [...toastListeners]) l();
};

/** Show a toast (the mockup's `cs-toast`): one at a time, the newest. It goes
 * after 6 s (12 s with an action), on Dismiss, or on an action. */
export function toast(text: string, ...actions: ToastAction[]): void {
  const t: Toast = { id: nextToast++, text, actions };
  toasts = [t];
  emit();
  setTimeout(() => dismissToast(t.id), actions.length ? 12_000 : 6_000);
}

export function dismissToast(id: number): void {
  toasts = toasts.filter((x) => x.id !== id);
  emit();
}

const subscribe = (l: () => void) => {
  toastListeners.add(l);
  return () => void toastListeners.delete(l);
};
const snapshot = () => toasts;

export function Toasts() {
  const list = useSyncExternalStore(subscribe, snapshot, snapshot);
  const t = list[0];
  if (!t) return null;
  const buttons = t.actions.map((a) => (
    <button
      key={a.label}
      className="tlink"
      type="button"
      onClick={() => {
        dismissToast(t.id);
        a.run();
      }}
    >
      {a.label}
    </button>
  ));
  return (
    <div className={t.actions.length > 1 ? "cs-toast-wrap sx-toastw" : "cs-toast-wrap"}>
      <div className="cs-toast" role="status">
        <span>{t.text}</span>
        {t.actions.length > 1 ? <span className="sx-tacts">{buttons}</span> : buttons}
        <button
          className="iconbtn"
          type="button"
          aria-label="Dismiss"
          onClick={() => dismissToast(t.id)}
        >
          <Svg src={I.close} />
        </button>
      </div>
    </div>
  );
}

// ---- writes ----

/** How a write ended: applied, refused (with the server's error), or no
 * answer (the screen offers Try again). */
export type Outcome =
  | {
      ok: true;
      result: unknown;
      /** Send again: the input as it was sent (its ids can be new). */
      input?: unknown;
      /** Send again: an earlier envelope of it had applied (`earlier`). */
      earlier?: boolean;
    }
  | { ok: false; error: ApiError }
  | { ok: false; error: null; local: string };

/** The toast of a refusal (the mockup's API_ERR.write). */
export function refusalToast(error: ApiError): void {
  toast(WRITE_ERROR[error.code] ?? WRITE_ERROR["unavailable"] ?? "");
}

/** Wait for a write's outcome; a refusal shows its toast unless `quiet`. */
async function settle(
  session: SpacesSession,
  w: { local: string; answer: Promise<Answer | null> },
  quiet: boolean,
): Promise<Outcome> {
  const a = await w.answer;
  if (a === null) return { ok: false, error: null, local: w.local };
  if (a.ok) return { ok: true, result: a.result };
  const code = a.error.code;
  if (!quiet) toast(WRITE_ERROR[code] ?? WRITE_ERROR["unavailable"] ?? "");
  // a refused write is shown once (here); the outbox forgets it
  session.client?.discard(w.local);
  return { ok: false, error: a.error };
}

export interface Writer {
  /** Make a write and wait for its outcome. */
  (name: string, input: unknown, o?: { quiet?: boolean }): Promise<Outcome>;
  /** Send a write that got no answer again, keeping its ids; `input`
   * changes its input (it must make the same ids). */
  retry(local: string, o?: { input?: unknown }): Promise<Outcome>;
}

export function useWrite(): Writer {
  const session = useSession();
  const make = async (
    name: string,
    input: unknown,
    o: { quiet?: boolean } = {},
  ): Promise<Outcome> => {
    if (!session) return { ok: false, error: { code: "UNAUTHORIZED", message: "Sign in." } };
    const w = session.write(name, input);
    if (!w) return { ok: false, error: { code: "UNAUTHORIZED", message: "Sign in." } };
    return settle(session, w, o.quiet === true);
  };
  const retry = async (local: string, o: { input?: unknown } = {}): Promise<Outcome> => {
    const c = session?.client;
    if (!session || !c || !c.sendAgain(local, o))
      return { ok: false, error: { code: "NOT_FOUND", message: "Gone." } };
    // the entry's state is the outcome: answered, or shown again
    return new Promise<Outcome>((resolve) => {
      const check = () => {
        const e = c.outbox().find((x) => x.local === local);
        if (!e) return false;
        if (e.state === "answered")
          resolve({ ok: true, result: e.result, input: e.input, earlier: e.earlier === true });
        else if (e.state === "refused" || e.state === "expired") {
          const error = e.error ?? { code: "BAD_REQUEST", message: "" };
          toast(WRITE_ERROR[error.code] ?? WRITE_ERROR["unavailable"] ?? "");
          c.discard(local);
          resolve({ ok: false, error });
        } else if (e.state === "failed" || e.state === "dropped")
          resolve({ ok: false, error: null, local });
        else return false;
        return true;
      };
      if (check()) return;
      const stop = c.onChange(() => {
        if (check()) stop();
      });
    });
  };
  return Object.assign(make, { retry });
}

/** Make a write whose outcome only a toast reports (a like, a save). */
export function useQuickWrite() {
  const write = useWrite();
  return (name: string, input: unknown) =>
    void write(name, input).then((o) => {
      if (!o.ok && o.error === null) toast(WRITE_ERROR["unavailable"] ?? "");
    });
}

// ---- creates ----

/** How a create ended: an `Outcome`, the id of the record it made, and
 * (applied) whether an earlier send had applied with the text it had then
 * while the text sent last differs (`lostEdits`). */
export type CreateOutcome = Outcome & { id: string; lostEdits: boolean };

/** A create: a write whose input names the id of the record it makes
 * (`threads.create`, a follow-up, a reply). A create that got no answer may
 * have applied (phase 2 review round 1, finding 2), so no second create is
 * made while it has none: the next send first reads the logs (`checking`);
 * a read that holds its record means it applied, and otherwise it is sent
 * again with the same id, the current input, and its earlier mutation ids
 * in `replaces`, so the server answers from an earlier envelope that
 * applied rather than making a second record. */
export function useCreate() {
  const session = useSession();
  const write = useWrite();
  const [lost, setLost] = useState<{ local: string; id: string; text: string } | null>(null);
  const [checking, setChecking] = useState(false);
  const send = async (
    name: string,
    make: (id: string) => Record<string, unknown>,
    o: { quiet?: boolean; text?: string } = {},
  ): Promise<CreateOutcome> => {
    const c = session?.client;
    if (!session || !c)
      return {
        ok: false,
        error: { code: "UNAUTHORIZED", message: "Sign in." },
        id: "",
        lostEdits: false,
      };
    const text = o.text ?? "";
    let id: string;
    let first: string;
    let out: Outcome;
    if (lost) {
      id = lost.id;
      first = lost.text;
      setChecking(true);
      try {
        await c.sync().catch(() => false);
        const e = c.outbox().find((x) => x.local === lost.local);
        // a read that holds its record answered it (or the entry is gone
        // after it was answered)
        out =
          !e || e.state === "answered"
            ? { ok: true, result: e?.result ?? null, earlier: true }
            : await write.retry(lost.local, { input: make(id) });
      } finally {
        setChecking(false);
      }
    } else {
      id = session.newId();
      first = text;
      out = await write(name, make(id), o);
    }
    if (out.ok) {
      setLost(null);
      const sent = (out.input as { id?: unknown } | undefined)?.id;
      return {
        ...out,
        id: typeof sent === "string" ? sent : id,
        lostEdits: out.earlier === true && o.text !== undefined && text !== first,
      };
    }
    if (out.error === null) setLost({ local: out.local, id, text: first });
    else setLost(null);
    return { ...out, id, lostEdits: false };
  };
  /** The draft was discarded: its create that got no answer is forgotten. */
  const forget = () => {
    if (lost) session?.client?.discard(lost.local);
    setLost(null);
  };
  return { send, forget, checking, lost: lost !== null };
}

/** The toast of a create that had applied before the person's later edits
 * (the mockup's AS_LOST, with Copy your edits). */
export function lostEditsToast(noun: string, draft: string): void {
  toast(
    `Your ${noun} went through before the error, so Session didn’t post it again. Your later edits weren’t saved.`,
    {
      label: "Copy your edits",
      run: () =>
        void Promise.resolve(navigator.clipboard?.writeText(draft))
          .catch(() => undefined)
          .then(() => toast("Copied your edits.")),
    },
  );
}
