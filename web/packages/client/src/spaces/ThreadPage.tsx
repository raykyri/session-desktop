// A thread (the mockup's question-tree layout for an ask, and its post layout
// for a post): the question, the agent's answer with live text while it
// runs, follow-ups or replies, and the side column (outline, cited sources,
// facts). A device run (phase 2 review round 1, finding 5; the mockup's
// sx-dr-label, sx-dr-view, sx-dr-int-web) is "Running on <handle>’s
// desktop" with its CLI and attempt and no token count, its answer is
// labelled "Answered on <handle>’s desktop · <CLI>", and after an interrupt
// the web offers only "Run with included tokens".

import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";

import { useRuntimeConfig } from "../api/account.js";
import {
  ageMinutes,
  ago,
  cliName,
  dayOf,
  deviceLabel,
  fmtT,
  spaceName,
  tokensWhy,
} from "../data/format.js";
import {
  threadView,
  type FollowUp,
  type Reply,
  type RunView,
  type Space,
  type ThreadView,
} from "../data/spaces.js";
import { Markdown, citationsOf } from "../features/markdown/index.js";
import { useNow, useRecords, useRunText } from "../sync/react.js";

import { AskMenu, Compare, MapDialog } from "./AskTree.js";
import { ItemMenu, ModNote, type Item } from "./ItemMenu.js";
import { MissingSpace, ThreadGate } from "./Membership.js";
import { Modal, NotFound, Page } from "./Page.js";
import { Svg } from "./Svg.js";
import {
  AskBox,
  LikeButton,
  ReplyBox,
  ReplyLike,
  SaveAskButton,
  SaveButton,
  Share,
  useRunControl,
} from "./ThreadWrites.js";
import { Author, Avatar, Lock } from "./atoms.js";
import { cx } from "./cx.js";
import { I, NVI, QTI } from "./icons.js";
import { BackButton, useNavState } from "./nav.js";
import { canRead, useWorld } from "./world.js";

const PROVIDER: Record<string, string> = {
  anthropic: "Anthropic",
  openrouter: "OpenRouter",
  google: "Google",
};

/** Who paid, as the meta line names it. */
function payerLabel(pay: string | null): string {
  return pay === null || pay === "session" ? "Included tokens" : "API key";
}

/** The steps a running answer has taken, from its committed turns. */
function stepsOf(turns: unknown[]): string[] {
  const out: string[] = [];
  for (const t of turns) {
    const blocks =
      (t as { blocks?: { type: string; name?: string; input?: unknown }[] }).blocks ?? [];
    for (const b of blocks) {
      if (b.type !== "toolUse") continue;
      const input = (b.input ?? {}) as Record<string, unknown>;
      const str = (v: unknown, d: string) => (typeof v === "string" ? v : d);
      if (b.name === "web_search") out.push(`Searched the web for “${str(input["query"], "")}”`);
      else if (b.name === "web_fetch") out.push(`Read ${str(input["url"], "a page")}`);
      else out.push(`Used ${b.name ?? "a tool"}`);
    }
  }
  return out;
}

/** A run that has not answered: running, or why it ended. */
function RunBox({
  run,
  tok,
  space,
  mine,
  thread,
  node,
}: {
  run: RunView;
  tok: number;
  space: Space;
  mine: boolean;
  thread: string;
  node: string;
}) {
  const live = useRunText(run.status === "running" ? run.id : null, run.attempt);
  const ctl = useRunControl(thread, node);
  const now = useNow();
  const key = useRecords(
    (r) => {
      const k = run.pay && run.pay !== "session" ? r.get("apikey", run.pay) : undefined;
      return k && k.u === r.me ? { name: k.name, cap: k.cap, provider: k.provider } : null;
    },
    [run.pay],
  );
  // the reader's other keys that can pay now (the mockup's tmActs)
  const others =
    useRecords(
      (r) =>
        r
          .list("apikey", (k) => k.u === r.me && k.status === "valid" && k.id !== run.pay)
          .map((k) => ({ id: k.id, name: k.name })),
      [run.pay],
    ) ?? [];
  const navigate = useNavigate();
  const dev = run.device;
  if (dev && (run.status === "queued" || run.status === "running")) {
    // a device run reports its text when it finishes, not its steps or
    // tokens (the mockup's sxRunLive, its default Variant)
    const m = Math.floor(ageMinutes(run.createdAt, now));
    return (
      <div className="run sx-drun">
        <div className="run-h">
          <span className="spin" aria-hidden="true" />
          <b>Running on {dev.u}’s desktop</b>
          <span className="faint">
            · {cliName(dev.cli)}
            {run.attempt > 1
              ? ` · attempt ${run.attempt}`
              : ` · started ${m < 1 ? "just now" : `${m} min ago`}`}
          </span>
          {mine ? (
            <button
              className="btn sm as-stop"
              type="button"
              disabled={ctl.busy}
              aria-disabled={ctl.busy || undefined}
              onClick={ctl.stop}
            >
              Stop
            </button>
          ) : null}
        </div>
        <p className="as-why">
          The answer shows here when {cliName(dev.cli)} finishes. Device runs report their text, not
          their steps or token use.
        </p>
      </div>
    );
  }
  if (dev && (run.end === "interrupted" || run.end === "too_large")) {
    // the mockup's sxRunEnd on the web: Run again only on the Mac that ran
    // it, so the web offers the included tokens
    const size = run.end === "too_large";
    return (
      <div className="run as-end as-fail" role="status">
        <div className="run-h">
          <span className="as-ic" aria-hidden="true">
            !
          </span>
          <b>{size ? "Couldn’t save the answer" : "Couldn’t finish the answer"}</b>
        </div>
        <p className="as-why">
          {size
            ? `The answer from ${cliName(dev.cli)} is larger than 200 KB, the limit for an answer from a device. Session didn’t save it.`
            : `The run stopped: ${dev.u}’s desktop went to sleep or lost its connection while ${cliName(dev.cli)} worked. The agent wrote nothing.${mine ? "" : ` ${dev.u} can run it again.`}`}
        </p>
        {mine ? (
          <div className="as-acts">
            <button
              className="btn sm primary"
              type="button"
              disabled={ctl.busy}
              onClick={ctl.included}
            >
              Run with included tokens
            </button>
          </div>
        ) : null}
      </div>
    );
  }
  if (run.status === "queued" || run.status === "running") {
    const steps = stepsOf(run.turns);
    return (
      <div className="run">
        <div className="run-h">
          <span className="spin" aria-hidden="true" />
          <b>Researching</b>
          {tok ? <span className="faint">· {fmtT(tok)} tokens so far</span> : null}
          {mine ? (
            <button
              className="btn sm as-stop"
              type="button"
              disabled={ctl.busy}
              aria-disabled={ctl.busy || undefined}
              onClick={ctl.stop}
            >
              Stop
            </button>
          ) : null}
        </div>
        {steps.length ? (
          <ol className="run-steps">
            {steps.map((s, k) => (
              <li key={k} className={k === steps.length - 1 && !live ? "cur" : "done"}>
                {s}
              </li>
            ))}
            <li className={live ? "cur" : ""}>Write the answer</li>
          </ol>
        ) : null}
        {live ? <Markdown markdown={live} className="prose qt-prose as-live" /> : null}
      </div>
    );
  }
  if (run.end === "stopped")
    return (
      <div className="run as-end" role="status">
        <p className="as-why">
          <b>Stopped.</b> The agent wrote nothing.{" "}
          {tok ? (
            <span className="faint num">{fmtT(tok)} tokens used from your included tokens.</span>
          ) : null}
        </p>
        {mine ? (
          <div className="as-acts">
            <button className="tlink" type="button" disabled={ctl.busy} onClick={ctl.again}>
              Run again
            </button>
          </div>
        ) : null}
      </div>
    );
  const why: Record<string, string> = {
    tokens: tokensWhy(run.pay, tok, now, key ?? null),
    // the mockup's tmFailHTML: the provider and the reader's own key by name
    key: key
      ? `${key.provider} rejected your ${key.name}. The agent wrote nothing.`
      : `${PROVIDER[run.model?.split("/")[0] ?? ""] ?? "The provider"} rejected the API key that pays for this ask. The agent wrote nothing.`,
    rate: key
      ? `${key.provider} is limiting requests from your ${key.name}. The agent wrote nothing.`
      : "The provider is limiting requests from the API key that pays for this ask. The agent wrote nothing.",
    access: `The agent didn’t run: when the run began, you could no longer read ${spaceName(space)} or a source this ask is about, or the API key that pays isn’t yours.`,
    interrupted: run.device
      ? `The run stopped on ${run.device.u}’s desktop before it finished. The agent wrote nothing.`
      : "The server restarted while the agent worked and couldn’t resume the run. The agent wrote nothing.",
    too_large: "The answer was over 200 KB, so it wasn’t saved.",
  };
  return (
    <div className="run as-end as-fail" role="status">
      <div className="run-h">
        <span className="as-ic" aria-hidden="true">
          !
        </span>
        <b>Couldn’t finish the answer</b>
      </div>
      <p className="as-why">{why[run.end ?? "interrupted"] ?? why["interrupted"]}</p>
      {mine ? (
        <div className="as-acts">
          {run.end === "tokens" ? (
            // another payer runs it again; with none, add a key
            run.pay === null || run.pay === "session" ? (
              others[0] ? (
                <button
                  className="btn sm primary"
                  type="button"
                  disabled={ctl.busy}
                  onClick={() => ctl.payWith(others[0]?.id ?? "")}
                >
                  Use {others[0].name}
                </button>
              ) : (
                <button
                  className="tlink"
                  type="button"
                  onClick={() => void navigate({ to: "/settings/$tab", params: { tab: "keys" } })}
                >
                  Add an API key
                </button>
              )
            ) : (
              <>
                <button
                  className="btn sm primary"
                  type="button"
                  disabled={ctl.busy}
                  onClick={ctl.included}
                >
                  Use included tokens
                </button>
                <button
                  className="tlink"
                  type="button"
                  onClick={() => void navigate({ to: "/settings/$tab", params: { tab: "keys" } })}
                >
                  Change limit
                </button>
              </>
            )
          ) : run.end === "key" ? (
            <>
              <button className="tlink" type="button" disabled={ctl.busy} onClick={ctl.included}>
                Retry with included tokens
              </button>
              <button
                className="tlink"
                type="button"
                onClick={() => void navigate({ to: "/settings/$tab", params: { tab: "keys" } })}
              >
                API keys
              </button>
            </>
          ) : (
            <button className="tlink" type="button" disabled={ctl.busy} onClick={ctl.again}>
              Retry
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** The thread's answer: the run's state until it answers, then the text. */
function Answer({ t, space, mine }: { t: ThreadView; space: Space; mine: boolean }) {
  const ended = t.run && t.run.status !== "complete";
  const showRun = t.running || (t.sum === null && ended);
  return (
    <section className={cx("th-ans", showRun && "running")} id="th-a">
      <div className="cr-label">
        <span className="agent">
          <Svg src={I.agent} />
        </span>
        Agent answer
      </div>
      {t.mod ? (
        <ModNote itemKey={`a:${t.id}`} noun="answer" mod={t.mod} by="the agent" space={space} />
      ) : showRun && t.run ? (
        <RunBox run={t.run} tok={t.tok} space={space} mine={mine} thread={t.id} node="r" />
      ) : t.sum !== null ? (
        <Markdown markdown={t.sum} className="prose qt-prose" />
      ) : null}
    </section>
  );
}

/** The thread's own menu: its answer (an ask) or the post. */
function ThreadMenu({ t, space }: { t: ThreadView; space: Space }) {
  const w = useWorld();
  const ask = t.k === "ask";
  const own = w.me?.u === t.u && !t.del;
  const item: Item = {
    key: `${ask ? "a" : "p"}:${t.id}`,
    noun: own && ask ? "ask" : ask ? "answer" : "post",
    by: ask && !own ? "Agent" : t.u,
    text: ask ? (t.sum ?? t.q) : t.q,
    q: t.q,
    mod: t.mod,
    own,
    kids: ask ? t.followups.length : t.replies.length,
    url: `${location.origin}/s/${space.name}/t/${t.id}`,
  };
  return <ItemMenu item={item} space={space} />;
}

function Actions({
  t,
  space,
  asking,
  onAsk,
}: {
  t: ThreadView;
  space: Space;
  asking?: boolean;
  onAsk?: () => void;
}) {
  return (
    <div className="p-foot">
      {onAsk ? (
        <button
          className="btn sm"
          type="button"
          aria-label="Ask about this answer"
          aria-expanded={asking ?? false}
          onClick={onAsk}
        >
          <Svg src={QTI.ask} />
          <span>
            Ask <span className="m-long">about this answer</span>
          </span>
        </button>
      ) : null}
      <LikeButton t={t} />
      <SaveButton t={t} />
      <Share t={t} space={space} />
      <ThreadMenu t={t} space={space} />
    </div>
  );
}

function FollowUpItem({
  t,
  f,
  level,
  space,
  me,
  sel,
  path,
  onPick,
}: {
  t: ThreadView;
  f: FollowUp;
  level: number;
  space: Space;
  me: string | null;
  sel: string;
  path: Set<string>;
  /** Compare with another ask: the outline or the map picks the second. */
  onPick: (id: string) => void;
}) {
  const now = useNow();
  const [asking, setAsking] = useState(false);
  const kids = t.followups.filter((x) => x.par === f.id);
  const count = (id: string): number =>
    t.followups.filter((x) => x.par === id).reduce((n, x) => n + 1 + count(x.id), 0);
  const below = count(f.id);
  const [open, setOpen] = useState(path.has(f.id) && sel !== f.id);
  const [onPath, setOnPath] = useState(path.has(f.id));
  if (onPath !== path.has(f.id)) {
    setOnPath(path.has(f.id));
    if (path.has(f.id) && sel !== f.id) setOpen(true);
  }
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (sel === f.id) ref.current?.scrollIntoView({ block: "center" });
  }, [sel, f.id]);
  const running = f.run && (f.run.status === "queued" || f.run.status === "running");
  const live = useRunText(running && f.run ? f.run.id : null, f.run?.attempt);
  return (
    <div className={cx("fu qt-fu", sel === f.id && "on")} id={`qt-n-${f.id}`} ref={ref}>
      <div className="meta">
        <Avatar u={f.u} className="sm" />
        <b>{f.u}</b>
        <span>{ago(f.createdAt, now)}</span>
      </div>
      <p className="fu-q">{f.del ? "You deleted this follow-up." : f.q}</p>
      <div className="fu-a">
        {f.mod ? (
          <ModNote
            itemKey={`f:${t.id}:${f.id}`}
            noun="follow-up answer"
            mod={f.mod}
            by="the agent"
            space={space}
          />
        ) : f.a !== null ? (
          <Markdown markdown={f.a} className="prose fu-prose" />
        ) : running && f.run?.device ? (
          <RunBox run={f.run} tok={0} space={space} mine={f.u === me} thread={t.id} node={f.id} />
        ) : running ? (
          <div className="run">
            <div className="run-h">
              <span className="spin" aria-hidden="true" />
              <b>Researching</b>
            </div>
            {live ? <Markdown markdown={live} className="prose fu-prose as-live" /> : null}
          </div>
        ) : f.run && !f.mod ? (
          <RunBox run={f.run} tok={0} space={space} mine={f.u === me} thread={t.id} node={f.id} />
        ) : null}
      </div>
      {f.a !== null && f.run?.device ? (
        <p className="tm-meta sx-dl">{deviceLabel(f.run.device)}</p>
      ) : f.a !== null ? (
        <p className="tm-meta">{payerLabel(f.run?.pay ?? null)}</p>
      ) : null}
      <div className="qt-acts">
        {!running ? (
          <button
            className="btn sm"
            type="button"
            aria-label="Ask about this answer"
            aria-expanded={asking}
            onClick={() => setAsking((a) => !a)}
          >
            <Svg src={QTI.ask} />
            <span>
              Ask <span className="m-long">about this answer</span>
            </span>
          </button>
        ) : null}
        <SaveAskButton thread={t.id} node={f.id} saved={f.saved} />
        <span className="grow" />
        <AskMenu t={t} f={f} space={space} onCompare={() => onPick(f.id)} />
      </div>
      {asking ? <AskBox t={t} par={f.id} level={level} onClose={() => setAsking(false)} /> : null}
      {below ? (
        <button
          className="tlink qt-fub"
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          {open
            ? `Hide ${below === 1 ? "the ask" : `${below} asks`} below`
            : `Show ${below} ${below === 1 ? "ask" : "asks"} below`}
        </button>
      ) : null}
      {open && kids.length ? (
        <div className="qt-fuk">
          {kids.map((k) => (
            <FollowUpItem
              key={k.id}
              t={t}
              f={k}
              level={level + 1}
              space={space}
              me={me}
              sel={sel}
              path={path}
              onPick={onPick}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ReplyItem({ t, r, kids }: { t: ThreadView; r: Reply; kids: Reply[] }) {
  const now = useNow();
  const w = useWorld();
  const space = w.byId.get(t.s);
  const me = w.me?.u ?? null;
  const [replying, setReplying] = useState(false);
  return (
    <div className={cx("rp", r.parent && "rp-kid")}>
      <Avatar u={r.u} className="sm" />
      <div className="rp-b">
        <div className="meta">
          <b>{r.u}</b>
          <span>{ago(r.createdAt, now)}</span>
        </div>
        {r.mod && space ? (
          <ModNote itemKey={`r:${t.id}:${r.id}`} noun="reply" mod={r.mod} by={r.u} space={space} />
        ) : (
          <p>{r.del ? "You deleted this reply." : r.t}</p>
        )}
        <div className="rp-acts">
          {r.parent === null ? (
            <button
              className="tlink"
              type="button"
              aria-expanded={replying}
              onClick={() => setReplying((x) => !x)}
            >
              Reply
            </button>
          ) : null}
          <ReplyLike id={r.id} likes={r.likes} liked={r.liked} />
          {space ? (
            <ItemMenu
              space={space}
              item={{
                key: `r:${t.id}:${r.id}`,
                noun: "reply",
                by: r.u,
                text: r.t,
                q: t.q,
                mod: r.mod,
                own: r.u === me && !r.del,
                kids: kids.length,
                url: `${location.origin}/s/${space.name}/t/${t.id}`,
              }}
            />
          ) : null}
        </div>
        {kids.map((k) => (
          <ReplyItem key={k.id} t={t} r={k} kids={[]} />
        ))}
        {replying ? (
          <ReplyBox t={t} to={{ id: r.id, u: r.u }} onClose={() => setReplying(false)} />
        ) : null}
      </div>
    </div>
  );
}

/** The ask tree's outline: the thread's ask and its follow-ups by parent. */
function Outline({
  t,
  title,
  sel,
  path,
  go,
  sheet = false,
}: {
  t: ThreadView;
  title: string;
  sel: string;
  path: Set<string>;
  go: (node: string) => void;
  /** In the phone's Outline sheet (no second #qt-ol). */
  sheet?: boolean;
}) {
  const kids = (par: string | null) => t.followups.filter((f) => f.par === par);
  const depth = (id: string | null): number => {
    let d = 0;
    let cur = id;
    while (cur) {
      d++;
      cur = t.followups.find((f) => f.id === cur)?.par ?? null;
    }
    return d;
  };
  const levels = t.followups.reduce((m, f) => Math.max(m, depth(f.id)), 0);
  const node = (f: FollowUp) => {
    const d = depth(f.id);
    const sub = kids(f.id);
    return (
      <li
        key={f.id}
        role="treeitem"
        aria-level={d + 1}
        aria-selected={f.id === sel}
        aria-expanded={sub.length ? true : undefined}
      >
        <button
          className={cx("qt-olr", path.has(f.id) && "path")}
          type="button"
          style={{ ["--d" as string]: d }}
          aria-current={f.id === sel}
          onClick={() => go(f.id)}
        >
          <Avatar u={f.u} />
          <span className="qt-olt">{f.q}</span>
          <span className="qt-olm" />
        </button>
        {sub.length ? (
          <ul role="group" style={{ ["--d" as string]: d + 1 }}>
            {sub.map(node)}
          </ul>
        ) : null}
      </li>
    );
  };
  return (
    <nav className="qt-ol" id={sheet ? undefined : "qt-ol"} aria-label="Outline of this thread">
      <div className="qt-ol-h">
        <h3>Outline</h3>
        <span className="num">
          {t.followups.length + 1} {t.followups.length ? "asks" : "ask"} · {levels}{" "}
          {levels === 1 ? "level" : "levels"}
        </span>
      </div>
      <ul role="tree">
        <li role="treeitem" aria-level={1} aria-selected={sel === "r"} aria-expanded="true">
          <button
            className="qt-olr top path"
            type="button"
            style={{ ["--d" as string]: 0 }}
            aria-current={sel === "r"}
            onClick={() => go("r")}
          >
            <Avatar u={t.u} />
            <span className="qt-olt">{title}</span>
            <span className="qt-olm" />
          </button>
          {kids(null).length ? (
            <ul role="group" style={{ ["--d" as string]: 1 }}>
              {kids(null).map(node)}
            </ul>
          ) : null}
        </li>
      </ul>
      <div className="qt-ol-legend" />
    </nav>
  );
}

function Facts({ t, space, kind }: { t: ThreadView; space: Space; kind: "ask" | "post" }) {
  const navigate = useNavigate();
  const config = useRuntimeConfig();
  const model = config.data?.models.find((m) => m.id === t.model);
  const people = new Set([t.u, ...t.followups.map((f) => f.u)]).size;
  const levels = t.followups.reduce((m, f) => {
    let d = 1;
    let p = f.par;
    while (p) {
      d++;
      p = t.followups.find((x) => x.id === p)?.par ?? null;
    }
    return Math.max(m, d);
  }, 0);
  return (
    <div className="th-facts">
      <div>
        <span>Space</span>
        <button
          className="tlink th-sp"
          type="button"
          onClick={() => void navigate({ to: "/s/$space", params: { space: space.name } })}
        >
          {spaceName(space)}
        </button>
      </div>
      <div>
        <span>{kind === "ask" ? "Started by" : "Posted by"}</span>
        <b>{t.u}</b>
      </div>
      {kind === "ask" ? (
        <>
          <div>
            <span>Asks</span>
            <b className="num">{t.followups.length + 1}</b>
          </div>
          <div>
            <span>People</span>
            <b className="num">{people}</b>
          </div>
          <div>
            <span>Levels</span>
            <b className="num">{levels}</b>
          </div>
          {t.run?.device ? (
            <div>
              <span>Ran on</span>
              <b>
                {t.run.device.u}’s desktop · {cliName(t.run.device.cli)}
              </b>
            </div>
          ) : t.model ? (
            <div>
              <span>Model</span>
              <b>{model?.label ?? t.model}</b>
            </div>
          ) : null}
          {t.tok ? (
            <>
              <div>
                <span>Tokens</span>
                <b className="num">{fmtT(t.tok)}</b>
              </div>
              <div className="tm-fby">
                <span>{payerLabel(t.pay)}</span>
                <b className="num">{fmtT(t.tok)}</b>
              </div>
            </>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function Sources({ md }: { md: string | null }) {
  const list = useMemo(() => citationsOf(md), [md]);
  if (!list.length) return null;
  return (
    <div className="ds-src">
      <h3>
        Sources <span className="num">{list.length}</span>
      </h3>
      <ol className="sx-src">
        {list.map((c) => (
          <li
            key={c.n}
            data-tasrc={c.n}
            tabIndex={0}
            // the mockup's source row: a list item that opens its page
            // eslint-disable-next-line jsx-a11y/no-noninteractive-element-to-interactive-role
            role="button"
            onClick={() => window.open(c.href, "_blank", "noopener")}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                window.open(c.href, "_blank", "noopener");
              }
            }}
          >
            <span className="sx-n num">{c.n}</span>
            <div>
              <b>{c.title}</b>
              <span>{c.host}</span>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** The link back: where it was opened from, else its space. */
function ThreadBack({ space }: { space: Space }) {
  const navigate = useNavigate();
  const { from } = useNavState();
  if (from && from.space !== space.id)
    return (
      <span className="nv-thh">
        <BackButton />
      </span>
    );
  return (
    <button
      className="th-back"
      type="button"
      onClick={() => void navigate({ to: "/s/$space", params: { space: space.name } })}
    >
      <Svg src={I.chev} className="bk" />
      {spaceName(space)}
      {space.vis !== "open" ? (
        <Lock className="cs-lk" title={space.vis === "unlisted" ? "Closed, unlisted" : "Closed"} />
      ) : null}
    </button>
  );
}

function Deleted({ t, space }: { t: ThreadView; space: Space }) {
  const navigate = useNavigate();
  const now = useNow();
  return (
    <div className="cs-napage nv-gone">
      <div className="cs-na">
        <span className="cs-na-ic">
          <Svg src={NVI.trash} />
        </span>
        <h2>This thread was deleted</h2>
        <p className="muted">
          {t.mod === "removed" ? (
            <>
              A moderator of {spaceName(space)} deleted this thread on {dayOf(t.updatedAt, now)}.
            </>
          ) : (
            <>
              <b>{t.u}</b> deleted this thread on {dayOf(t.updatedAt, now)}.
            </>
          )}{" "}
          Its question, answer and follow-ups are no longer available.
        </p>
        <div className="cs-na-b">
          <button
            className="btn primary"
            type="button"
            onClick={() => void navigate({ to: "/s/$space", params: { space: space.name } })}
          >
            Open {spaceName(space)}
          </button>
          <button className="btn" type="button" onClick={() => void navigate({ to: "/" })}>
            Go to Home
          </button>
        </div>
      </div>
    </div>
  );
}

export function ThreadPage({
  spaceName: name,
  id,
  node = "r",
  compare,
}: {
  spaceName: string;
  id: string;
  /** Two asks to compare (`/a/<a>/compare/<a>,<b>`). */
  compare?: [string, string];
  /** The selected ask ("r": the thread's), from `/a/<node>`. */
  node?: string;
}) {
  const navigate = useNavigate();
  const w = useWorld();
  const now = useNow();
  const { focus } = useNavState();
  const s = w.spaces.find((x) => x.name === name);
  const session = w.session;
  const [view, setView] = useState<"docsrc" | "chat">("docsrc");
  const [askingRoot, setAskingRoot] = useState(false);
  const [olSheet, setOlSheet] = useState(false);
  const [mapOpen, setMapOpen] = useState(false);
  const [pick, setPick] = useState<string | null>(null);
  useEffect(() => {
    if (s) void session?.openThread(s.id, id);
  }, [s, id, session]);
  const t = useRecords((r) => threadView(r, id), [id]);
  const heading = useRef<HTMLParagraphElement>(null);
  const loaded = t?.id;
  useEffect(() => {
    if (focus && loaded) heading.current?.focus();
  }, [focus, loaded]);
  if (!s) {
    if (!w.loaded) return <Page place={{ kind: "other" }}>{null}</Page>;
    return <MissingSpace name={name} thread={true} />;
  }
  if (!canRead(w, s))
    return (
      <Page cls="" place={{ kind: "space", id: s.id }}>
        <ThreadGate s={s} />
      </Page>
    );
  if (!t)
    return (
      <Page place={{ kind: "thread", id: s.id }}>
        {session?.status().ready ? <NotFound /> : null}
      </Page>
    );
  const mine = w.me?.u === t.u;
  if (t.del && t.k === "post" && t.replies.length === 0)
    return (
      <Page place={{ kind: "thread", id: s.id }}>
        <Deleted t={t} space={s} />
      </Page>
    );
  const meta = (
    <div className="meta">
      <Avatar u={t.u} className="sm" />
      <Author u={t.u} />
      <span>{ago(t.createdAt, now)}</span>
      {t.k === "post" ? <span className="faint">· post</span> : null}
    </div>
  );
  if (t.k === "post") {
    const tops = t.replies.filter((x) => x.parent === null);
    return (
      <Page place={{ kind: "thread", id: s.id }}>
        <div className="th-page">
          <div className="th-doc">
            <article className="th-main">
              <div className="th-top">
                <ThreadBack space={s} />
              </div>
              {meta}
              <p className="th-q th-post" id="th-q" ref={heading} tabIndex={-1}>
                {t.del ? "You deleted this post." : t.mod ? null : t.q}
              </p>
              {t.mod ? (
                <ModNote itemKey={`p:${t.id}`} noun="post" mod={t.mod} by={t.u} space={s} />
              ) : null}
              <Actions t={t} space={s} />
              <section className="th-rps" id="th-f">
                <h3>
                  Replies <span className="faint num">{t.replies.length}</span>
                </h3>
                {tops.map((r) => (
                  <ReplyItem
                    key={r.id}
                    t={t}
                    r={r}
                    kids={t.replies.filter((k) => k.parent === r.id)}
                  />
                ))}
                {s.archived ? null : <ReplyBox t={t} />}
              </section>
            </article>
            <aside className="th-aside">
              <Facts t={t} space={s} kind="post" />
            </aside>
          </div>
        </div>
      </Page>
    );
  }
  const first = t.followups.filter((f) => f.par === null);
  // the selected ask and the asks above it
  const path = new Set<string>();
  for (let cur: string | null = node; cur && cur !== "r";) {
    path.add(cur);
    const at: string = cur;
    cur = t.followups.find((f) => f.id === at)?.par ?? null;
  }
  const go = (n: string) => {
    if (pick && n !== pick && n !== "r") {
      const a = pick;
      setPick(null);
      void navigate({
        to: "/s/$space/t/$thread/a/$node/compare/$pair",
        params: { space: s.name, thread: t.id, node: a, pair: `${a},${n}` },
      });
      return;
    }
    void navigate(
      n === "r"
        ? { to: "/s/$space/t/$thread", params: { space: s.name, thread: t.id } }
        : { to: "/s/$space/t/$thread/a/$node", params: { space: s.name, thread: t.id, node: n } },
    );
  };
  return (
    <Page place={{ kind: "thread", id: s.id }}>
      <div className="th-page qt-page">
        <div className="qt-bar">
          <ThreadBack space={s} />
          <div className="qt-tools">
            <div className="seg th-vt" role="group" aria-label="View">
              <button
                type="button"
                aria-pressed={view === "docsrc"}
                onClick={() => setView("docsrc")}
              >
                Document
              </button>
              <button type="button" aria-pressed={view === "chat"} onClick={() => setView("chat")}>
                Transcript
              </button>
            </div>
            <button
              className="btn sm"
              type="button"
              data-qt="map"
              aria-pressed={mapOpen}
              onClick={() => setMapOpen(true)}
              aria-label="Map"
              title="Map"
            >
              <Svg src={QTI.map} />
              <span className="qt-tl">Map</span>
            </button>
            <button
              className="btn sm qt-olbtn"
              type="button"
              onClick={() => setOlSheet(true)}
              aria-pressed={olSheet}
              aria-label="Outline"
              title="Outline"
            >
              <Svg src={QTI.tree ?? QTI.map} />
              <span className="qt-tl">Outline</span>
            </button>
          </div>
        </div>
        <div className="qt-grid qt-calm">
          <div className="qt-main">
            {pick ? (
              <div className="qt-pickbar" role="status">
                <span>
                  Choose a second ask to compare with{" "}
                  <b>{t.followups.find((f) => f.id === pick)?.q.slice(0, 60)}</b>, in the outline or
                  on the map.
                </span>
                <span className="grow" />
                <button className="btn sm" type="button" onClick={() => setMapOpen(true)}>
                  <Svg src={QTI.map} />
                  Open the map
                </button>
                <button className="btn sm qt-olbtn" type="button" onClick={() => setOlSheet(true)}>
                  <Svg src={QTI.tree} />
                  Outline
                </button>
                <button className="btn sm" type="button" onClick={() => setPick(null)}>
                  Cancel
                </button>
              </div>
            ) : null}
            {compare ? (
              <Compare
                t={t}
                space={s}
                a={compare[0]}
                b={compare[1]}
                go={(n) => go(n)}
                close={() => go(compare[0])}
              />
            ) : null}
            <article className="qt-node qt-inl qt-fuv" id="qt-n-r" hidden={!!compare}>
              {meta}
              <p className="th-q" id="th-q" ref={heading} tabIndex={-1}>
                {t.del ? "You deleted this ask." : t.q}
              </p>
              <Answer t={t} space={s} mine={mine} />
              {t.sum !== null && t.run?.device && t.run.status === "complete" ? (
                <p className="tm-meta sx-dl">{deviceLabel(t.run.device)}</p>
              ) : t.sum !== null && t.tok ? (
                <p className="tm-meta">
                  {payerLabel(t.pay)} · <span className="num">{fmtT(t.tok)} tokens</span>
                </p>
              ) : null}
              <Actions
                t={t}
                space={s}
                asking={askingRoot}
                onAsk={t.running ? undefined : () => setAskingRoot((a) => !a)}
              />
              {askingRoot && !t.running ? (
                <div className="qt-rootask qt-rootask-in">
                  <AskBox t={t} par="r" level={0} onClose={() => setAskingRoot(false)} />
                </div>
              ) : null}
              <section className="th-fus" id="th-f">
                <h3>
                  Follow-ups <span className="faint num">{first.length}</span>
                  {first.length ? (
                    <div className="seg qt-fut" role="group" aria-label="Show follow-ups as">
                      <button type="button" aria-pressed="true">
                        Answers
                      </button>
                      <button type="button" aria-pressed="false">
                        Questions
                      </button>
                    </div>
                  ) : null}
                </h3>
                {first.length ? (
                  first.map((f) => (
                    <FollowUpItem
                      key={f.id}
                      t={t}
                      f={f}
                      level={1}
                      space={s}
                      me={w.me?.u ?? null}
                      sel={node}
                      path={path}
                      onPick={setPick}
                    />
                  ))
                ) : (
                  <p className="muted">Follow-ups appear here once the answer is ready.</p>
                )}
              </section>
            </article>
          </div>
          <aside className="qt-aside">
            <Outline t={t} title={t.t ?? t.q} sel={node} path={path} go={go} />
            {olSheet ? (
              <Modal title="Outline" wrap="qt-olm-sheet" onClose={() => setOlSheet(false)}>
                <Outline
                  sheet
                  t={t}
                  title={t.t ?? t.q}
                  sel={node}
                  path={path}
                  go={(n) => {
                    setOlSheet(false);
                    go(n);
                  }}
                />
              </Modal>
            ) : null}
            <Sources md={t.sum} />
            <Facts t={t} space={s} kind="ask" />
          </aside>
          {mapOpen ? (
            <MapDialog t={t} sel={node} path={path} go={go} onClose={() => setMapOpen(false)} />
          ) : null}
        </div>
      </div>
    </Page>
  );
}
