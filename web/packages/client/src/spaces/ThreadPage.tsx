// A thread (the mockup's question-tree layout for an ask, and its post layout
// for a post): the question, the agent's answer with live text while it
// runs, follow-ups or replies, and the side column (outline, cited sources,
// facts).

import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";

import { useRuntimeConfig } from "../api/account.js";
import { ago, dayOf, fmtT, spaceName } from "../data/format.js";
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

import { NotFound, Page } from "./Page.js";
import { Svg } from "./Svg.js";
import { Author, Avatar, Lock } from "./atoms.js";
import { CI, I, NVI, QTI, SFI } from "./icons.js";
import { BackButton, useNavState } from "./nav.js";
import { useWorld } from "./world.js";

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
}: {
  run: RunView;
  tok: number;
  space: Space;
  mine: boolean;
}) {
  const live = useRunText(run.status === "running" ? run.id : null, run.attempt);
  if (run.status === "queued" || run.status === "running") {
    const steps = stepsOf(run.turns);
    return (
      <div className="run">
        <div className="run-h">
          <span className="spin" aria-hidden="true" />
          <b>Researching</b>
          {tok ? <span className="faint">· {fmtT(tok)} tokens so far</span> : null}
          {mine ? (
            <button className="btn sm as-stop" type="button">
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
            <button className="tlink" type="button">
              Run again
            </button>
          </div>
        ) : null}
      </div>
    );
  const why: Record<string, string> = {
    tokens: `You’ve used this month’s included tokens. The agent stopped${tok ? ` after ${fmtT(tok)} tokens` : ""} and wrote nothing.`,
    key: `${PROVIDER[run.model?.split("/")[0] ?? ""] ?? "The provider"} rejected the API key that pays for this ask. The agent wrote nothing.`,
    rate: "The provider is limiting requests from the API key that pays for this ask. The agent wrote nothing.",
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
          <button className="tlink" type="button">
            Retry
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** The thread's answer: the run's state until it answers, then the text. */
function Answer({ t, space, mine }: { t: ThreadView; space: Space; mine: boolean }) {
  const ended = t.run && t.run.status !== "complete" && !(t.run.status === "cancelled");
  const showRun = t.running || (t.sum === null && ended);
  return (
    <section className={`th-ans${showRun ? "running" : ""}`} id="th-a">
      <div className="cr-label">
        <span className="agent">
          <Svg src={I.agent} />
        </span>
        Agent answer
      </div>
      {t.mod ? (
        <p className="muted">Answer {t.mod} by a moderator.</p>
      ) : showRun && t.run ? (
        <RunBox run={t.run} tok={t.tok} space={space} mine={mine} />
      ) : t.sum !== null ? (
        <Markdown markdown={t.sum} className="prose qt-prose" />
      ) : null}
    </section>
  );
}

function Actions({ t, kind }: { t: ThreadView; kind: "ask" | "post" }) {
  return (
    <div className="p-foot">
      {kind === "ask" ? (
        <button
          className="btn sm"
          type="button"
          aria-label="Ask about this answer"
          aria-expanded="false"
        >
          <Svg src={QTI.ask} />
          <span>
            Ask <span className="m-long">about this answer</span>
          </span>
        </button>
      ) : null}
      <button
        className="act"
        type="button"
        data-toggle="liked"
        aria-pressed={t.liked}
        aria-label="Like"
      >
        <Svg src={I.heart} />
        <span className="num">{t.likes}</span>
      </button>
      <button
        className="act"
        type="button"
        data-toggle="saved"
        aria-pressed={t.saved}
        aria-label={t.saved ? "Remove from saved" : "Save"}
        title={t.saved ? "Saved" : "Save"}
      >
        <Svg src={I.mark} />
      </button>
      <span className="sf-imw ta-shw">
        <button
          className="act"
          type="button"
          aria-haspopup="true"
          aria-expanded="false"
          aria-label="Share"
        >
          <Svg src={CI.share} />
          <span>Share</span>
        </button>
      </span>
      <span className="sf-imw sf-pend">
        <button
          className="act sf-im"
          type="button"
          aria-haspopup="true"
          aria-expanded="false"
          aria-label="More actions"
          title="More"
        >
          <Svg src={SFI.more} />
        </button>
      </span>
    </div>
  );
}

function FollowUpItem({ f, below }: { f: FollowUp; below: number }) {
  const now = useNow();
  const running = f.run && (f.run.status === "queued" || f.run.status === "running");
  const live = useRunText(running && f.run ? f.run.id : null, f.run?.attempt);
  return (
    <div className="fu qt-fu" id={`qt-n-${f.id}`}>
      <div className="meta">
        <Avatar u={f.u} className="sm" />
        <b>{f.u}</b>
        <span>{ago(f.createdAt, now)}</span>
      </div>
      <p className="fu-q">
        {f.del ? "You deleted this follow-up." : f.mod ? `Follow-up ${f.mod} by a moderator.` : f.q}
      </p>
      <div className="fu-a">
        {f.a !== null && !f.mod ? (
          <Markdown markdown={f.a} className="prose fu-prose" />
        ) : running ? (
          <div className="run">
            <div className="run-h">
              <span className="spin" aria-hidden="true" />
              <b>Researching</b>
            </div>
            {live ? <Markdown markdown={live} className="prose fu-prose as-live" /> : null}
          </div>
        ) : null}
      </div>
      {f.a !== null ? <p className="tm-meta">{payerLabel(f.run?.pay ?? null)}</p> : null}
      <div className="qt-acts">
        <button className="btn sm" type="button" aria-label="Ask about this answer">
          <Svg src={QTI.ask} />
          <span>
            Ask <span className="m-long">about this answer</span>
          </span>
        </button>
        <button
          className="act sf-im qt-save"
          type="button"
          aria-pressed={f.saved}
          aria-label="Save this ask"
          title="Save this ask"
        >
          <Svg src={I.mark} />
        </button>
        <span className="grow" />
        <span className="qt-mw">
          <button
            className="act sf-im"
            type="button"
            aria-haspopup="true"
            aria-expanded="false"
            aria-label="More actions for this ask"
            title="More"
          >
            <Svg src={SFI.more} />
          </button>
        </span>
      </div>
      {below ? (
        <button className="tlink qt-fub" type="button" aria-expanded="false">
          Show {below} {below === 1 ? "ask" : "asks"} below
        </button>
      ) : null}
    </div>
  );
}

function ReplyItem({ r, kids }: { r: Reply; kids: Reply[] }) {
  const now = useNow();
  return (
    <div className={`rp${r.parent ? "rp-kid" : ""}`}>
      <Avatar u={r.u} className="sm" />
      <div className="rp-b">
        <div className="meta">
          <b>{r.u}</b>
          <span>{ago(r.createdAt, now)}</span>
        </div>
        <p>{r.del ? "You deleted this reply." : r.mod ? `Reply ${r.mod} by a moderator.` : r.t}</p>
        <div className="rp-acts">
          <button className="tlink" type="button" aria-expanded="false">
            Reply
          </button>
          <button
            className="tlink ta-like"
            type="button"
            aria-pressed={r.liked}
            aria-label={`Like (${r.likes} ${r.likes === 1 ? "like" : "likes"})`}
          >
            <Svg src={I.heart} />
            <span className="num">{r.likes}</span>
          </button>
          <span className="sf-imw">
            <button
              className="act sf-im"
              type="button"
              aria-haspopup="true"
              aria-expanded="false"
              aria-label="More actions"
              title="More"
            >
              <Svg src={SFI.more} />
            </button>
          </span>
        </div>
        {kids.map((k) => (
          <ReplyItem key={k.id} r={k} kids={[]} />
        ))}
      </div>
    </div>
  );
}

/** The ask tree's outline: the thread's ask and its follow-ups by parent. */
function Outline({ t, title }: { t: ThreadView; title: string }) {
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
        aria-selected="false"
        aria-expanded={sub.length ? true : undefined}
      >
        <button
          className="qt-olr"
          type="button"
          style={{ ["--d" as string]: d }}
          aria-current="false"
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
    <nav className="qt-ol" id="qt-ol" aria-label="Outline of this thread">
      <div className="qt-ol-h">
        <h3>Outline</h3>
        <span className="num">
          {t.followups.length + 1} asks · {levels} {levels === 1 ? "level" : "levels"}
        </span>
      </div>
      <ul role="tree">
        <li role="treeitem" aria-level={1} aria-selected="true" aria-expanded="true">
          <button
            className="qt-olr top path"
            type="button"
            style={{ ["--d" as string]: 0 }}
            aria-current="true"
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
          {t.model ? (
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

export function ThreadPage({ spaceName: name, id }: { spaceName: string; id: string }) {
  const w = useWorld();
  const now = useNow();
  const { focus } = useNavState();
  const s = w.spaces.find((x) => x.name === name);
  const session = w.session;
  const [view, setView] = useState<"docsrc" | "chat">("docsrc");
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
    return (
      <Page place={{ kind: "other" }}>
        <NotFound space={name} />
      </Page>
    );
  }
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
                {t.del ? "You deleted this post." : t.mod ? `Post ${t.mod} by a moderator.` : t.q}
              </p>
              <Actions t={t} kind="post" />
              <section className="th-rps" id="th-f">
                <h3>
                  Replies <span className="faint num">{t.replies.length}</span>
                </h3>
                {tops.map((r) => (
                  <ReplyItem key={r.id} r={r} kids={t.replies.filter((k) => k.parent === r.id)} />
                ))}
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
  const below = (fid: string): number => {
    const kids = t.followups.filter((f) => f.par === fid);
    return kids.reduce((n, k) => n + 1 + below(k.id), 0);
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
              aria-pressed="false"
              aria-label="Map"
              title="Map"
            >
              <Svg src={QTI.map} />
              <span className="qt-tl">Map</span>
            </button>
            <button
              className="btn sm qt-olbtn"
              type="button"
              aria-pressed="false"
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
            <article className="qt-node qt-inl qt-fuv" id="qt-n-r">
              {meta}
              <p className="th-q" id="th-q" ref={heading} tabIndex={-1}>
                {t.del ? "You deleted this ask." : t.mod ? `Ask ${t.mod} by a moderator.` : t.q}
              </p>
              <Answer t={t} space={s} mine={mine} />
              {t.sum !== null && t.tok ? (
                <p className="tm-meta">
                  {payerLabel(t.pay)} · <span className="num">{fmtT(t.tok)} tokens</span>
                </p>
              ) : null}
              <Actions t={t} kind="ask" />
              <section className="th-fus" id="th-f">
                <h3>
                  Follow-ups <span className="faint num">{first.length}</span>
                  <div className="seg qt-fut" role="group" aria-label="Show follow-ups as">
                    <button type="button" aria-pressed="true">
                      Answers
                    </button>
                    <button type="button" aria-pressed="false">
                      Questions
                    </button>
                  </div>
                </h3>
                {first.length ? (
                  first.map((f) => <FollowUpItem key={f.id} f={f} below={below(f.id)} />)
                ) : (
                  <p className="muted">Follow-ups can be added once the answer is ready.</p>
                )}
              </section>
            </article>
          </div>
          <aside className="qt-aside">
            <Outline t={t} title={t.t ?? t.q} />
            <Sources md={t.sum} />
            <Facts t={t} space={s} kind="ask" />
          </aside>
        </div>
      </div>
    </Page>
  );
}
