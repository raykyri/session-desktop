// The Desktop app's sync-state UI (phase 3; AGENTS.md, "Sync-state UI", and
// the mockup's sx-ob-*, sx-off-app, sx-rf-forbidden and sx-up-app, with its
// default Variants): the header's Unsent changes badge and its popover, the
// Unsent changes page (`/unsent`), the status of a write the outbox holds
// under its item, and the toasts of the writes that need the person
// (failed after 5 tries, EXPIRED, dropped after 3 days, refused). A STALE
// decision is not applied again: its toast says why, and it stays in the
// list with Dismiss; a refused write with text stays in the list, where Copy
// text recovers it. The toasts stay until the person dismisses them or the
// write they name changes (the mockup's sxShowToast). Only a session that
// keeps its outbox (`persist: true`) shows any of this.

import type { OutboxEntry, SyncClient } from "@session/sync/client";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";

import { agoText, spaceName } from "../data/format.js";
import { writeClipboardText } from "../lib/clipboard.js";
import { platform } from "../platform.js";
import { useNow, useSession, useStatus } from "../sync/react.js";
import type { SpacesSession } from "../sync/session.js";

import { Svg } from "./Svg.js";
import { Avatar } from "./atoms.js";
import { cx } from "./cx.js";
import { CI, I, SXI } from "./icons.js";
import {
  describe,
  isBad,
  isModeration,
  listHead,
  staleText,
  statusOf,
  type ObAct,
  type ObItem,
  type ObKind,
} from "./outbox.js";
import { useOverlay } from "./overlay.js";
import { isAwaited, pruneToasts, stickyToast, toast } from "./writes.js";

const KIND_ICON: Record<ObKind, string> = {
  reply: SXI.reply,
  fu: I.agent,
  post: I.write,
  ask: I.agent,
  like: SXI.heart,
  save: SXI.up,
  page: SXI.doc,
  show: SXI.eye,
  hide: CI.eyeOff,
  approve: SXI.user,
  edit: I.write,
  delete: SXI.up,
  other: SXI.up,
};

/** The outbox's writes the person sees: every write not answered yet. */
const shownEntries = (c: SyncClient) => c.outbox().filter((e) => e.state !== "answered");

/** What the sync-state copy calls this device ("this Mac"). */
const hereName = () => platform().here ?? "this device";

/** When each write of this window was sent (the mockup's sxSent): Unsent
 * changes says how many were sent in the past minute. */
let sentAt: number[] = [];
const SENT_WINDOW = 60_000;
const sentLately = (now: number) => sentAt.filter((t) => now - t < SENT_WINDOW).length;

/** A space's name as the list shows it, from the replica. */
const labelIn = (session: SpacesSession) => (sp: string) => {
  const s = session.reader().get("space", sp);
  return s ? spaceName(s) : null;
};

/** The kept outbox's client, and a version that moves with each change of
 * it (0 and null on the web, which keeps no outbox). */
function useKept(): { c: SyncClient | null; session: SpacesSession | null; ver: number } {
  const session = useSession();
  const c = session?.persistent ? session.client : null;
  const ver = useSyncExternalStore(
    (l) => (c ? c.onChange(l) : () => undefined),
    () => (c ? c.version() : 0),
  );
  return { c, session, ver };
}

/** The client's outbox, as items, kept current (a retry's countdown each
 * second). */
export function useOutbox(): { items: ObItem[]; sent: number; client: SyncClient | null } {
  const { c, session, ver } = useKept();
  const now = useNow(1000);
  return useMemo(() => {
    void ver;
    if (!c || !session) return { items: [], sent: 0, client: null };
    const r = session.reader();
    return {
      items: shownEntries(c).map((e) => describe(e, r, labelIn(session), now, c.updateRequired)),
      sent: sentLately(now),
      client: c,
    };
  }, [c, session, ver, now]);
}

// ---- the popover's state (one per window) ----

let popOpen = false;
const popListeners = new Set<() => void>();
function setPop(v: boolean) {
  if (popOpen === v) return;
  popOpen = v;
  for (const l of [...popListeners]) l();
}
const usePop = () =>
  useSyncExternalStore(
    (l) => (popListeners.add(l), () => void popListeners.delete(l)),
    () => popOpen,
  );

// ---- actions ----

/** What a write's action does. */
export function useObAct() {
  const session = useSession();
  const navigate = useNavigate();
  return (o: ObItem, act: ObAct) => {
    const c = session?.client;
    if (!c) return;
    switch (act) {
      case "copy":
        void writeClipboardText(o.text)
          .catch(() => undefined)
          .then(() => toast("Text copied."));
        return;
      case "discard":
        if (c.discard(o.local)) toast(isBad(o) ? "Removed from Unsent changes." : "Discarded.");
        return;
      case "retryNow":
        void c.retryNow();
        return;
      case "retry":
      case "again": {
        if (!c.sendAgain(o.local)) return;
        const done =
          act === "again"
            ? o.kind === "post"
              ? "Posted again."
              : o.kind === "reply"
                ? "Sent as a new reply."
                : "Sent again."
            : "Sent.";
        const stop = c.onChange(() => {
          const e = c.outbox().find((x) => x.local === o.local);
          if (e && e.state !== "answered" && e.state !== "queued") stop();
          else if (!e || e.state === "answered") {
            stop();
            toast(done);
          }
        });
        return;
      }
      case "editor": {
        const page = o.page ? session.reader().get("page", o.page) : undefined;
        const s = o.space;
        const name = s ? session.reader().get("space", s)?.name : undefined;
        if (!page || !name) return;
        const i = c.outbox().find((x) => x.local === o.local)?.input as
          { title?: string; text?: string[]; base?: { rev?: number } } | undefined;
        openPageDraft(name, page.slug, {
          title: i?.title ?? page.t,
          body: (i?.text ?? []).join("\n\n"),
          ver: i?.base?.rev ?? 0,
        });
        c.discard(o.local);
        setPop(false);
        void navigate({ to: "/s/$space/pages/$slug", params: { space: name, slug: page.slug } });
        return;
      }
    }
  };
}

// ---- a page edit sent late: its text back in the editor ----

export interface PageDraft {
  title: string;
  body: string;
  /** The version the edit was made on (the base of its save). */
  ver: number;
}
const pageDrafts = new Map<string, PageDraft>();

/** The page editor opens with this text and its conflict notice (the
 * mockup's ec-page-unsent). */
export function openPageDraft(space: string, slug: string, d: PageDraft): void {
  pageDrafts.set(`${space}/${slug}`, d);
}

/** The draft Unsent changes left for a page's editor, once. */
export function takePageDraft(space: string, slug: string): PageDraft | null {
  const k = `${space}/${slug}`;
  const d = pageDrafts.get(k) ?? null;
  pageDrafts.delete(k);
  return d;
}

// ---- the list ----

function Acts({ o, s }: { o: ObItem; s: ReturnType<typeof statusOf> }) {
  const act = useObAct();
  if (!s.acts.length) return null;
  return (
    <span className="sx-acts">
      {s.acts.map(([label, a, primary]) => (
        <button
          key={a}
          className={primary ? "btn sm primary" : "tlink"}
          type="button"
          onClick={() => act(o, a)}
        >
          {label}
        </button>
      ))}
    </span>
  );
}

function Row({ o }: { o: ObItem }) {
  const status = useStatus();
  const now = useNow(1000);
  const s = statusOf(o, { here: hereName(), offline: !status.online, now });
  return (
    <div className={cx("sx-row", `sx-${s.tone}`)} data-sxrow={o.local}>
      <span className="sx-ric">
        <Svg src={KIND_ICON[o.kind]} />
      </span>
      <div className="sx-rb">
        <div className="sx-rh">
          <b>{o.title}</b>
          <span className="faint num">{agoText(o.made, now)}</span>
        </div>
        {o.text && o.kind !== "page" ? <p className="sx-rt">{o.text}</p> : null}
        <p className="sx-rs">
          {s.head ? <b>{s.head}.</b> : null}
          {s.head ? " " : null}
          {s.text}
        </p>
        <Acts o={o} s={s} />
      </div>
    </div>
  );
}

/** The list's body (`sxListBody`): its first line, Needs you, Waiting to
 * send, and the writes sent just now. */
export function UnsentList() {
  const { items, sent } = useOutbox();
  const status = useStatus();
  const here = hereName();
  const bad = items.filter(isBad);
  const wait = items.filter((o) => !isBad(o));
  return (
    <>
      <p className="muted sx-lh">
        {listHead({ here, offline: !status.online, update: status.updateRequired })}
      </p>
      {bad.length ? (
        <section className="sx-sec">
          <h3>Needs you</h3>
          {bad.map((o) => (
            <Row key={o.local} o={o} />
          ))}
        </section>
      ) : null}
      {wait.length ? (
        <section className="sx-sec">
          <h3>Waiting to send</h3>
          {wait.map((o) => (
            <Row key={o.local} o={o} />
          ))}
        </section>
      ) : null}
      {sent ? (
        <p className="faint sx-sent">
          {sent === 1 ? "1 change was" : `${sent} changes were`} sent just now.
        </p>
      ) : null}
      {items.length ? null : (
        <p className="muted">Nothing is waiting. Changes are sent as you make them.</p>
      )}
    </>
  );
}

/** The header's badge (`sxBadge`) and its popover. */
export function UnsentBadge() {
  const { items } = useOutbox();
  const open = usePop();
  const navigate = useNavigate();
  const wrap = useRef<HTMLDivElement>(null);
  useOverlay(open, () => setPop(false));
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setPop(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);
  useEffect(() => {
    if (!items.length) setPop(false);
  }, [items.length]);
  if (!items.length) return null;
  return (
    <div className="sx-bw" ref={wrap}>
      <button
        className={cx("btn hb sx-badge", items.some(isBad) && "bad")}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Unsent changes"
        onClick={() => setPop(!open)}
      >
        <Svg src={SXI.up} />
        <span className="num">{items.length}</span>
        <span className="sx-bl">unsent</span>
      </button>
      {open ? (
        <div className="ts-ddmenu sx-pop" role="dialog" aria-label="Unsent changes">
          <div className="mp-h">Unsent changes</div>
          <div className="sx-popb">
            <UnsentList />
          </div>
          <div className="ts-ddsep" />
          <button
            className="ts-opt"
            type="button"
            onClick={() => {
              setPop(false);
              void navigate({ to: "/unsent" });
            }}
          >
            <span className="ts-tx">
              <b>Open Unsent changes</b>
            </span>
          </button>
        </div>
      ) : null}
    </div>
  );
}

// ---- under an item: a write the outbox holds ----

/** The outbox's write that made the record with this id, if it is not
 * answered yet (the Desktop app). */
export function usePendingItem(id: string | null): ObItem | null {
  const { c, session, ver } = useKept();
  return useMemo(() => {
    void ver;
    if (!c || !session || !id) return null;
    const e = shownEntries(c).find((x) => x.minted.includes(id));
    return e ? describe(e, session.reader(), labelIn(session), c.now(), c.updateRequired) : null;
  }, [c, session, ver, id]);
}

/** The writes of replies the outbox set aside in a thread: they are no
 * longer in the replica's view, and the thread shows them where they were
 * (the mockup's `sx-rp sx-gone`). */
export function useHeldReplies(thread: string): ObItem[] {
  const { c, session, ver } = useKept();
  return useMemo(() => {
    void ver;
    if (!c || !session) return [];
    const r = session.reader();
    return shownEntries(c)
      .map((e) => describe(e, r, labelIn(session), c.now(), c.updateRequired))
      .filter((o) => o.kind === "reply" && o.thread === thread && isBad(o));
  }, [c, session, ver, thread]);
}

/** The status under an item the outbox holds (`sxItemSt`): a waiting
 * write's message, or a shown one's tag (its message is in a toast). */
export function ItemStatus({ o }: { o: ObItem }) {
  const status = useStatus();
  const now = useNow(1000);
  const s = statusOf(o, { here: hereName(), offline: !status.online, now });
  const full = o.state !== "retry" && !isBad(o);
  const bad = s.tone === "bad";
  if (!full)
    return (
      <div className={cx("sx-st", `sx-${s.tone}`)} role={bad ? "alert" : "status"}>
        <span className={cx("sx-tag", !bad && "wait")}>{s.head ?? "Not sent yet"}</span>
      </div>
    );
  return (
    <div className={cx("sx-st", `sx-${s.tone}`)} role="status">
      <span className="sx-sic">
        <Svg src={SXI.clock} />
      </span>
      <span className="sx-stx">{s.text}</span>
      <Acts o={o} s={s} />
    </div>
  );
}

/** A reply the outbox holds, drawn where the replica puts it
 * (`sxReplyWeb`). */
export function HeldReply({ o, me }: { o: ObItem; me: string }) {
  return (
    <div className={cx("rp sx-rp", (o.state === "expired" || o.state === "dropped") && "sx-gone")}>
      <Avatar u={me} className="sm" />
      <div className="rp-b">
        <div className="meta">
          <b>{me}</b>
          <span className="faint">{isBad(o) ? "not saved" : "not sent yet"}</span>
        </div>
        <p>{o.text}</p>
        <ItemStatus o={o} />
      </div>
    </div>
  );
}

// ---- the toasts of writes that need the person ----

type Seen = Map<string, string>;

/** The key of an entry's state for its toast: a new key is a new toast. */
const toastKey = (e: OutboxEntry) =>
  e.state === "queued" ? (e.tries > 0 ? `retry:${e.tries}` : "wait") : e.state;

/** Watches the outbox and shows the toast of each write that came to need
 * the person (the mockup's default Variants: toasts), never over the list it
 * points to. Writes a screen still waits on are the screen's. */
export function OutboxToasts() {
  const session = useSession();
  return session?.persistent ? <Watcher /> : null;
}

/** FORBIDDEN refusals of one space: one toast, except a single write that is
 * not a moderator's, which gets its own (with Copy text). */
function forbiddenGroups(list: ObItem[]): ObItem[][] {
  const by = new Map<string, ObItem[]>();
  for (const o of list) by.set(o.space ?? "", [...(by.get(o.space ?? "") ?? []), o]);
  return [...by.values()];
}

function Watcher() {
  const session = useSession();
  const navigate = useNavigate();
  const act = useObAct();
  const seen = useRef<Seen | null>(null);
  const forbidden = useRef<ObItem[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const actRef = useRef(act);
  useEffect(() => {
    actRef.current = act;
  });
  useEffect(() => {
    const c = session?.persistent ? session.client : null;
    if (!c || !session) return;
    const details = { label: "Details", run: () => void navigate({ to: "/unsent" }) };
    const describeNow = (e: OutboxEntry) =>
      describe(e, session.reader(), labelIn(session), c.now(), c.updateRequired);
    const entry = (local: string) => c.outbox().find((x) => x.local === local);
    /** Not over the list the toast points to (the popover, `/unsent`). */
    const hidden = () => popOpen || location.pathname === "/unsent";
    /** A write's toast: it stays until dismissed, and goes once the write
     * left the state it names (sent, retried, dismissed in the list). Its
     * text is read from the write as it is now (a retry's countdown; the
     * space's name once the replica has it). */
    const say = (
      o: ObItem,
      k: string,
      text: (now: ObItem) => string,
      ...actions: { label: string; run: () => void }[]
    ) => {
      if (hidden()) return;
      stickyToast({
        key: `ob:${o.local}`,
        text: () => {
          const e = entry(o.local);
          return text(e ? describeNow(e) : o);
        },
        actions,
        live: () => {
          const e = entry(o.local);
          return e !== undefined && toastKey(e) === k;
        },
      });
    };
    /** The toast of a write shown to the person (`sxStatus`'s head, its
     * first action, and Details). */
    const badToast = (o: ObItem, k: string) => {
      const s = statusOf(o, { here: hereName(), offline: !session.status().online, now: c.now() });
      const first = s.acts[0];
      say(
        o,
        k,
        (x) =>
          `${s.head ?? "Not saved"}: your ${x.noun}${x.spaceLabel ? ` in ${x.spaceLabel}` : ""}.`,
        ...(first ? [{ label: first[0], run: () => actRef.current(o, first[1]) }] : []),
        details,
      );
    };
    const flushForbidden = () => {
      timer.current = null;
      const list = forbidden.current;
      forbidden.current = [];
      for (const group of forbiddenGroups(list)) {
        const one = group[0];
        if (!one) continue;
        if (group.length === 1 && !isModeration(one)) {
          badToast(one, "refused");
          continue;
        }
        if (hidden()) continue;
        const mod = group.every(isModeration);
        const n = group.length;
        const what = mod
          ? n === 1
            ? "moderation action"
            : "moderation actions"
          : n === 1
            ? "change"
            : "changes";
        stickyToast({
          key: `ob-forbidden:${one.local}`,
          text: () => {
            const where = one.space ? labelIn(session)(one.space) : null;
            return `${n} ${what}${where ? ` in ${where}` : ""} ${n === 1 ? "wasn’t" : "weren’t"} applied.`;
          },
          actions: [details],
          live: () => group.some((o) => entry(o.local)?.state === "refused"),
        });
      }
    };
    const check = () => {
      const next: Seen = new Map();
      let again = false;
      for (const e of c.outbox()) {
        const k = toastKey(e);
        const was = seen.current?.get(e.local);
        // a write a screen still waits on is the screen's; it is looked at
        // again once the screen let it go (in the same change)
        if (was !== k && isAwaited(e.local)) {
          next.set(e.local, was ?? "");
          again = true;
          continue;
        }
        next.set(e.local, k);
        if (was === k) continue;
        if (k === "answered" && was !== undefined) sentAt = [...sentAt, c.now()];
        if (k === "wait" || k === "held" || k === "answered") continue;
        const o = describeNow(e);
        if (o.state === "retry") {
          say(
            o,
            k,
            (x) =>
              `Not sent yet: the server didn’t answer. Next try in ${x.next} s (try ${x.tries} of 5).`,
            { label: "Retry now", run: () => actRef.current(o, "retryNow") },
          );
        } else if (o.state === "stale" && !o.text) {
          // a decision whose item changed: not applied again; it stays in
          // Unsent changes until the person dismisses it
          say(o, k, staleText);
        } else if (o.state === "forbidden") {
          // the writes the same replay refuses are one toast per space: it
          // waits until none came for half a second
          forbidden.current.push(o);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(flushForbidden, 500);
        } else if (isBad(o)) badToast(o, k);
      }
      seen.current = next;
      sentAt = sentAt.filter((t) => c.now() - t < SENT_WINDOW);
      pruneToasts();
      if (again) setTimeout(check, 0);
    };
    check();
    const stop = c.onChange(check);
    return () => {
      stop();
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [session, navigate]);
  return null;
}
