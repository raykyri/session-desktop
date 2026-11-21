// An answer's Markdown (02 §4.4): rendered with raw HTML off, through the
// shared remark plugins and the answer's rehype plugins (passages,
// citations). A passage with branches gets the passage shade and an inline
// count button; the passage an open composer quotes gets the accent tint;
// each citation opens its source in a popover.

import { Popover } from "@base-ui/react/popover";
import { baseRemarkPlugins, safeHref } from "@session/shared";
import type { ComponentPropsWithoutRef, ElementType, ReactNode, Ref } from "react";
import { createContext, memo, useContext, useMemo, useRef } from "react";
import ReactMarkdown, { type Components } from "react-markdown";

import { cn } from "../../lib/cn.js";
import { rehypeCitations, rehypePassages } from "../markdown/answerPlugins.js";

import { ReplyArrowIcon } from "./icons.js";

/** The branches on one passage (its count button). */
export interface PassageGroup {
  /** All the branches in the passage's tree. */
  total: number;
  open: () => void;
  hovered: boolean;
  onHover: (on: boolean) => void;
}

export interface AnswerProseProps {
  md: string;
  /** The cited pages: [title, host, note]. */
  pages: readonly (readonly [string, string, string])[];
  groups?: ReadonlyMap<number, PassageGroup> | undefined;
  /** The passage an open composer quotes. */
  quoted?: number | null | undefined;
  className?: string;
  proseRef?: Ref<HTMLDivElement> | undefined;
  /** The answer's thread, for the element id the selection actions find. */
  id?: string | undefined;
}

const REHYPE = [rehypePassages, rehypeCitations];
const PASSAGE_TAGS = ["p", "li", "h1", "h2", "h3", "h4", "h5", "h6", "table", "pre", "blockquote"];

function noun(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}

function CitationButton({ n, pages }: { n: string; pages: AnswerProseProps["pages"] }) {
  const page = pages[Number(n) - 1];
  if (!page) return <sup className="text-fg-faint">{n}</sup>;
  return <Citation n={n} page={page} />;
}

/** The popover's link takes focus when it opens (02 §10.1). */
function Citation({ n, page }: { n: string; page: readonly [string, string, string] }) {
  const link = useRef<HTMLAnchorElement>(null);
  const [title, host, note] = page;
  const href = safeHref(`https://${host}`);
  return (
    <Popover.Root>
      <Popover.Trigger className="cite" aria-label={`Source ${n}`}>
        {n}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner
          side="bottom"
          align="start"
          sideOffset={6}
          alignOffset={-12}
          className="z-(--z-popover)"
        >
          <Popover.Popup
            className="citepop static outline-none"
            aria-label={`Source ${n}`}
            initialFocus={link}
          >
            <div className="cp-h">
              <span className="cp-n">{n}</span>
              <b>{title}</b>
            </div>
            {note ? <p>{note}</p> : null}
            {href ? (
              <a ref={link} href={href} target="_blank" rel="noopener noreferrer">
                {host} ↗
              </a>
            ) : null}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** What the passage components read: the groups, the quoted passage, the
 * cited pages. Through a context, so the components keep their identity and
 * React never remounts the answer's elements (a remount would drop the
 * reader's selection). */
interface ProseState {
  groups: ReadonlyMap<number, PassageGroup> | undefined;
  quoted: number | null | undefined;
  pages: AnswerProseProps["pages"];
}

const ProseContext = createContext<ProseState>({ groups: undefined, quoted: null, pages: [] });

function passageComponent(Tag: string) {
  return function Passage({
    node,
    children,
    ...props
  }: ComponentPropsWithoutRef<"p"> & { node?: unknown }) {
    void node;
    const { groups, quoted } = useContext(ProseContext);
    const raw = (props as Record<string, unknown>)["data-passage"];
    const index = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : null;
    const group = index === null ? undefined : groups?.get(index);
    const El = Tag as ElementType;
    let content: ReactNode = children;
    if (group)
      content = (
        <>
          {children}
          <button
            type="button"
            className="anc"
            title="Open the branches on this passage"
            aria-label={`${noun(group.total, "branch", "branches")} on this passage. Open the first`}
            onClick={group.open}
          >
            <ReplyArrowIcon />
            {group.total}
          </button>
        </>
      );
    return (
      <El
        {...props}
        className={cn(index !== null && index === quoted ? "qsel" : undefined)}
        {...(group
          ? {
              "data-grp": "",
              onMouseEnter: () => group.onHover(true),
              onMouseLeave: () => group.onHover(false),
            }
          : {})}
      >
        {content}
      </El>
    );
  };
}

function CitationSlot({ node, ...props }: ComponentPropsWithoutRef<"button"> & { node?: unknown }) {
  void node;
  const { pages } = useContext(ProseContext);
  const n = (props as Record<string, unknown>)["data-cite"];
  return typeof n === "string" ? <CitationButton n={n} pages={pages} /> : null;
}

const COMPONENTS: Components = {
  a: ({ href, children }) => {
    const safe = safeHref(href);
    return safe ? (
      <a href={safe} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    );
  },
  img: ({ alt }) => (alt ? <span>{alt}</span> : null),
  button: CitationSlot,
  ...Object.fromEntries(PASSAGE_TAGS.map((tag) => [tag, passageComponent(tag)])),
};

const Markdown = memo(function Markdown({ md }: { md: string }) {
  return (
    <ReactMarkdown remarkPlugins={baseRemarkPlugins} rehypePlugins={REHYPE} components={COMPONENTS}>
      {md}
    </ReactMarkdown>
  );
});

export const AnswerProse = memo(function AnswerProse({
  md,
  pages,
  groups,
  quoted,
  className,
  proseRef,
  id,
}: AnswerProseProps) {
  const state = useMemo(() => ({ groups, quoted, pages }), [groups, quoted, pages]);
  return (
    <div ref={proseRef} className={cn("answer", className)} {...(id ? { id } : {})}>
      <ProseContext.Provider value={state}>
        <Markdown md={md} />
      </ProseContext.Provider>
    </div>
  );
});
