// The composer (the mockup's `composer`, c2 with the bar variant): closed, a
// field-like button; open, Ask or Post, the text, the model and who pays (an
// ask), the space (on Home), and Ask or Post. A thread is made with the
// client's ULID (`threads.create`); the person goes to it at once. A create
// that got no answer keeps the text and offers Retry, and is never made a
// second time (`useCreate`): Post or Retry first checks whether it went
// through (the mockup's as-post-check), opens it if it did (as-post-lost,
// with Copy your edits when the text changed since), and otherwise sends it
// again with the same id. A draft closed with Escape or Close asks before it
// is discarded. Who pays is aware of providers (phase 2a design finding 6):
// a key pays only for its own provider's models, so the model menu lists the
// models the payer runs, a key that runs none of them is not offered, and a
// model the payer cannot run changes to one it can, with the mockup's note.

import type { ModelInfo } from "@session/shared";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { useMe, useRuntimeConfig } from "../api/account.js";
import { spaceName } from "../data/format.js";
import type { Space } from "../data/spaces.js";
import { useRecords } from "../sync/react.js";

import { DiscardDialog, LeaveGuard } from "./Discard.js";
import { Scrim } from "./Scrim.js";
import { Svg } from "./Svg.js";
import { Glyph } from "./atoms.js";
import { I } from "./icons.js";
import { useOverlay } from "./overlay.js";
import { useWorld } from "./world.js";
import { lostEditsToast, useCreate } from "./writes.js";

const GLOBE =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><circle cx="8" cy="8" r="5.8"/><path d="M2.4 8h11.2M8 2.2c1.7 1.6 2.6 3.6 2.6 5.8S9.7 12.2 8 13.8M8 2.2C6.3 3.8 5.4 5.8 5.4 8s.9 4.2 2.6 5.8"/></svg>';

/** The provider an API key must be of to pay for a model's calls (the
 * server's rule: a key pays only for its own provider's models). */
const KEY_PROVIDER: Record<string, string> = { anthropic: "Anthropic", openrouter: "OpenRouter" };
/** A provider's models, as the mockup's note names them (TM_FAM). */
const FAMILY: Record<string, string> = { Google: "Gemini", OpenAI: "GPT", Anthropic: "Claude" };

interface Payer {
  id: string;
  name: string;
  provider: string;
}

/** The models a payer runs: a key, its provider's; the included tokens,
 * every available model (one only for admins, for an admin). */
export function modelsFor(
  pay: string,
  models: readonly ModelInfo[],
  keys: readonly Payer[],
  admin: boolean,
): ModelInfo[] {
  const ok = models.filter((m) => m.available);
  if (pay === "session") return ok.filter((m) => admin || !m.adminOnly);
  const k = keys.find((x) => x.id === pay);
  return k ? ok.filter((m) => KEY_PROVIDER[m.provider] === k.provider) : [];
}

/** The model an ask runs with: the person's choice when the payer runs it,
 * else the payer's first model, and the mockup's note when it changed. */
export function modelChoice(
  pay: string,
  chosen: string,
  models: readonly ModelInfo[],
  keys: readonly Payer[],
  admin: boolean,
): { list: ModelInfo[]; model: ModelInfo | undefined; note: string | null } {
  const list = modelsFor(pay, models, keys, admin);
  const want = models.find((m) => m.id === chosen);
  const model = list.find((m) => m.id === chosen) ?? list[0];
  const k = keys.find((x) => x.id === pay);
  const note =
    want && model && want.id !== model.id && k
      ? `${k.name} runs ${FAMILY[k.provider] ?? k.provider} models, so the model changed from ${want.label} to ${model.label}.`
      : null;
  return { list, model, note };
}

/** Who pays for an ask: the included tokens, or one of the person's keys
 * that runs at least one of the models. */
function usePayers(): Payer[] {
  const w = useWorld();
  const config = useRuntimeConfig();
  const me = w.me?.u ?? null;
  const keys =
    useRecords(
      (r) =>
        me
          ? r
              .list("apikey", (k) => k.u === me && k.status === "valid")
              .map((k) => ({ id: k.id, name: k.name, provider: k.provider }))
          : [],
      [me],
    ) ?? [];
  const models = config.data?.models ?? [];
  return keys.filter((k) => modelsFor(k.id, models, keys, false).length > 0);
}

/** The model and who pays for an ask, aware of providers. */
export function useAskModel(pay: string, chosen: string) {
  const config = useRuntimeConfig();
  const admin = useMe().data?.isAdmin === true;
  const keys = usePayers();
  return modelChoice(pay, chosen, config.data?.models ?? [], keys, admin);
}

export function ModelMenu({
  model,
  setModel,
  pay,
}: {
  model: string;
  setModel: (m: string) => void;
  pay: string;
}) {
  const [open, setOpen] = useState(false);
  useOverlay(open, () => setOpen(false));
  const { list: models, model: cur, note } = useAskModel(pay, model);
  return (
    <div className="mp mp-base">
      <button
        className="chip dd"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Svg src={GLOBE} />
        <span>{cur?.label ?? "Model"}</span>
        <Svg src={I.chev} />
      </button>
      {open ? (
        <>
          <Scrim onClose={() => setOpen(false)} />
          <div className="pop mp-pop" role="menu" aria-label="Model">
            <div className="grp eyebrow">Model</div>
            {note ? (
              <p className="tm-mnote" role="status">
                {note}
              </p>
            ) : null}
            {models.map((m) => (
              <button
                key={m.id}
                className="pop-row"
                type="button"
                role="menuitemradio"
                aria-checked={m.id === cur?.id}
                aria-current={m.id === cur?.id}
                onClick={() => {
                  setModel(m.id);
                  setOpen(false);
                }}
              >
                {m.label}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

export function PayerLine({ pay, setPay }: { pay: string; setPay: (p: string) => void }) {
  const keys = usePayers();
  const [open, setOpen] = useState(false);
  useOverlay(open, () => setOpen(false));
  const label =
    pay === "session"
      ? "Use included tokens"
      : `Use ${keys.find((k) => k.id === pay)?.name ?? "API key"}`;
  return (
    <span className="c2-note tm-line">
      <button
        className="tlink tm-who"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {label}
        <Svg src={I.chev} />
      </button>
      {open ? (
        <>
          <Scrim onClose={() => setOpen(false)} />
          <div className="pop tm-pop" role="menu" aria-label="Who pays">
            <button
              className="pop-row"
              type="button"
              role="menuitemradio"
              aria-checked={pay === "session"}
              onClick={() => {
                setPay("session");
                setOpen(false);
              }}
            >
              Included tokens
            </button>
            {keys.map((k) => (
              <button
                key={k.id}
                className="pop-row"
                type="button"
                role="menuitemradio"
                aria-checked={pay === k.id}
                onClick={() => {
                  setPay(k.id);
                  setOpen(false);
                }}
              >
                {k.name}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </span>
  );
}

export function Composer({ space }: { space: Space | null }) {
  const w = useWorld();
  const navigate = useNavigate();
  const create = useCreate();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"ask" | "post">("ask");
  const [draft, setDraft] = useState("");
  const [model, setModel] = useState("");
  const [pay, setPay] = useState("session");
  const asked = useAskModel(pay, model);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const joined = Object.keys(w.roles)
    .flatMap((id) => w.byId.get(id) ?? [])
    .filter((s) => !s.archived);
  const [spaceId, setSpaceId] = useState<string | null>(null);
  const target = space ?? joined.find((s) => s.id === spaceId) ?? joined[0] ?? null;
  const postsOff = target?.postsOff ?? false;
  const ask = mode === "ask" || postsOff;
  const ta = useRef<HTMLTextAreaElement>(null);
  // set while a create goes to its thread: that move is not leaving the draft
  const sending = useRef(false);
  useEffect(() => {
    if (open) ta.current?.focus();
  }, [open]);
  const close = () => {
    if (draft.trim()) setConfirm(true);
    else setOpen(false);
  };
  useOverlay(open && !confirm, close);

  if (!w.me)
    return (
      <button
        className="composer c2-closed"
        type="button"
        onClick={() =>
          void navigate({ to: "/login", search: { redirect: location.pathname + location.search } })
        }
      >
        <span className="ph">Log in to ask a question{space?.postsOff ? "" : " or post"}</span>
      </button>
    );
  if (space?.archived)
    return (
      <div className="cs-strip cx-ro" role="status">
        This space is archived. You can read its threads, but not ask, post or reply.
      </div>
    );
  if (!open)
    return (
      <button className="composer c2-closed" type="button" onClick={() => setOpen(true)}>
        <span className="ph">
          {space?.postsOff ? "Make a query…" : "Make a query, or write a post…"}
        </span>
      </button>
    );

  const runs = asked.model?.id ?? null;
  const submit = async () => {
    if (!target || !draft.trim() || busy) return;
    setBusy(true);
    const q = draft.trim();
    const make = (id: string) =>
      ask
        ? {
            id,
            space: target.id,
            kind: "ask",
            q,
            pay,
            ...(runs ? { model: runs } : {}),
          }
        : { id, space: target.id, kind: "post", q };
    // the person goes to the thread once the server has it: a create that
    // got no answer keeps the composer open with its text and Retry
    const o = await create.send("threads.create", make, { text: q });
    setBusy(false);
    if (!o.ok) return;
    sending.current = true;
    setDraft("");
    setOpen(false);
    void navigate({ to: "/s/$space/t/$thread", params: { space: target.name, thread: o.id } });
    if (o.lostEdits) lostEditsToast("post", q);
  };
  const modes: ["ask" | "post", string, string, string][] = [
    [
      "ask",
      "Ask",
      "An agent researches the question and posts a sourced answer. Uses tokens.",
      I.agent,
    ],
    [
      "post",
      "Post",
      postsOff && target
        ? `Posts are turned off in ${spaceName(target)}`
        : "A plain post. People reply. Uses no tokens.",
      I.write,
    ],
  ];
  return (
    <>
      <div className="composer open c2 c2v-bar">
        <button
          className="iconbtn c2-x"
          type="button"
          aria-label="Close composer"
          title="Close"
          onClick={close}
        >
          <Svg src={I.close} />
        </button>
        <textarea
          id="compose-text"
          ref={ta}
          rows={2}
          placeholder={ask ? "Make a query" : "Write a post"}
          aria-label={ask ? "Query" : "Post text"}
          value={draft}
          onChange={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit();
          }}
        />
        <div className="c2-bar">
          <div className="seg c2-mode" role="group" aria-label="Thread kind">
            {modes.map(([k, l, d, ic]) => (
              <button
                key={k}
                type="button"
                aria-pressed={(k === "ask") === ask}
                title={d}
                disabled={k === "post" && postsOff}
                aria-disabled={k === "post" && postsOff ? true : undefined}
                onClick={() => setMode(k)}
              >
                <Svg src={ic} />
                {l}
              </button>
            ))}
          </div>
          {ask ? (
            <ModelMenu model={model} setModel={setModel} pay={pay} />
          ) : (
            <span className="c2-note c2-free">Posts use no tokens.</span>
          )}
          <span className="grow" />
          {create.checking ? (
            <span className="c2-note as-perr as-pchk" role="status">
              <span className="spin" aria-hidden="true" />
              Checking whether your post went through…
            </span>
          ) : create.lost ? (
            <span className="c2-note warn as-perr" role="alert">
              Couldn’t post. Try again.{" "}
              <button className="tlink" type="button" onClick={() => void submit()}>
                Retry
              </button>
            </span>
          ) : ask ? (
            <PayerLine pay={pay} setPay={setPay} />
          ) : null}
          <span className="c2-end">
            {target ? (
              space ? (
                <span className="c2-sp static">
                  <Glyph s={target} />
                  {spaceName(target)}
                </span>
              ) : (
                <SpacePick spaces={joined} cur={target} onPick={setSpaceId} />
              )
            ) : null}
            <button
              className="btn primary"
              type="button"
              disabled={busy || create.checking || !draft.trim()}
              aria-disabled={busy || create.checking || !draft.trim()}
              onClick={() => void submit()}
            >
              {ask ? "Ask" : "Post"}
            </button>
          </span>
          {postsOff && target ? (
            <span className="c2-note sf-pnote">
              Posts are turned off in {spaceName(target)}. You can still reply to existing posts.
            </span>
          ) : null}
        </div>
      </div>
      <LeaveGuard
        when={() => !!draft.trim() && !sending.current && !confirm}
        title="Discard this draft?"
      />
      {confirm ? (
        <DiscardDialog
          title="Discard this draft?"
          onKeep={() => setConfirm(false)}
          onDiscard={() => {
            setConfirm(false);
            setDraft("");
            create.forget();
            setOpen(false);
          }}
        />
      ) : null}
    </>
  );
}

function SpacePick({
  spaces,
  cur,
  onPick,
}: {
  spaces: Space[];
  cur: Space;
  onPick: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  useOverlay(open, () => setOpen(false));
  return (
    <div className="c2-spm">
      <button
        className="c2-sp"
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Space: ${spaceName(cur)}`}
        onClick={() => setOpen((o) => !o)}
      >
        <Glyph s={cur} />
        <span>{spaceName(cur)}</span>
        <Svg src={I.chev} />
      </button>
      {open ? (
        <>
          <Scrim onClose={() => setOpen(false)} />
          <div className="ts-ddmenu c2-spmenu" role="listbox" aria-label="Space">
            {spaces.map((s) => (
              <button
                key={s.id}
                className="ts-opt"
                type="button"
                role="option"
                aria-selected={s.id === cur.id}
                onClick={() => {
                  onPick(s.id);
                  setOpen(false);
                }}
              >
                <Glyph s={s} />
                <span className="ts-tx">
                  <b className="cs-nmrow">{spaceName(s)}</b>
                </span>
                {s.id === cur.id ? <Svg src={I.check} /> : null}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
