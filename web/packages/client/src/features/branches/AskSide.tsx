// An ask's side column (02 §4.1; the mock's `pinGroups`, `outline`, `place`):
// one branch tree per passage that has branches, placed at the passage's
// height and pushed down 12 px past the tree above; the root composer of a
// follow-up or Branch here, placed at its passage; the selected branch's
// card under its tree. At 860 px and below the trees stack in reading order.

import type { NodeRec, ThreadRec } from "@session/mutators";
import type { RefObject } from "react";
import { useLayoutEffect, useRef, useState } from "react";

import { cn } from "../../lib/cn.js";
import type { ChannelView } from "../../replica/queries.js";
import type { DraftRef } from "../../replica/source.js";
import { useWrites } from "../../replica/writes.js";
import { composerKey, useThreadUi, useThreadUiStore } from "../../stores/threadUi.js";
import { Avatar } from "../../ui/Avatar.js";
import { InlineComposer, focusSoon, selectedRowOr } from "../composer/InlineComposer.js";
import { useFeedViewer, useRunChoice } from "../feed/FeedContext.js";
import { rowText } from "../feed/Moderated.js";
import { clip } from "../feed/format.js";
import { CloseIcon, SearchIcon } from "../feed/icons.js";

import { BranchCard } from "./BranchCard.js";
import { TreeRail, type TreeRow } from "./TreeRail.js";
import { placePins } from "./geometry.js";
import type { PassageTree, TreeIndex } from "./tree.js";

const narrow = () =>
  typeof window.matchMedia === "function" && window.matchMedia("(max-width: 860px)").matches;

export interface AskSideProps {
  thread: ThreadRec;
  index: TreeIndex;
  trees: PassageTree[];
  proseRef: RefObject<HTMLDivElement | null>;
  channel: ChannelView | null;
  now: number;
  hovered: number | null;
  onHover: (b: number | null) => void;
}

export function AskSide({
  thread,
  index,
  trees,
  proseRef,
  channel,
  now,
  hovered,
  onHover,
}: AskSideProps) {
  const ui = useThreadUi(thread.id);
  const select = useThreadUiStore((state) => state.select);
  const toggle = useThreadUiStore((state) => state.toggle);
  const open = useThreadUiStore((state) => state.open);
  const close = useThreadUiStore((state) => state.close);
  const writes = useWrites();
  const choice = useRunChoice();
  const { writer } = useFeedViewer();
  const pinned = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<{ tops: number[]; height: number }>({ tops: [], height: 0 });

  const composer = ui.composer;
  const rootAsk =
    writer && composer?.kind === "ask" && composer.parent === "r" && ui.selected === null
      ? composer
      : null;
  const quote = rootAsk?.quote;

  // Pins in order: the root composer (when open), then one per passage.
  const anchors: (number | null)[] = [
    ...(rootAsk ? [quote?.b ?? 0] : []),
    ...trees.map((t) => t.b),
  ];

  useLayoutEffect(() => {
    const margin = pinned.current;
    const prose = proseRef.current;
    if (!margin || !prose) return;
    const measure = () => {
      if (narrow()) {
        setLayout((prev) =>
          prev.height === 0 && prev.tops.length === 0 ? prev : { tops: [], height: 0 },
        );
        return;
      }
      const top = margin.getBoundingClientRect().top;
      const pins = Array.from(margin.querySelectorAll<HTMLElement>(":scope > .pin"));
      const items = pins.map((pin, i) => {
        const b = anchors[i] ?? 0;
        const unit =
          prose.querySelector<HTMLElement>(`[data-passage="${b}"]`) ??
          (prose.firstElementChild as HTMLElement | null);
        return {
          anchor: unit ? unit.getBoundingClientRect().top - top : 0,
          height: pin.offsetHeight,
        };
      });
      const next = placePins(items, 12);
      setLayout((prev) =>
        prev.height === next.height && prev.tops.join() === next.tops.join() ? prev : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(prose);
    for (const pin of Array.from(margin.querySelectorAll(":scope > .pin"))) observer.observe(pin);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  });

  const style = (i: number) => (layout.tops[i] === undefined ? undefined : { top: layout.tops[i] });
  const selectedPath = new Set(ui.selected ? index.path(ui.selected) : []);

  const submitRoot = async (text: string, draft: DraftRef) => {
    const id = await writes.fork({
      draft,
      thread: thread.id,
      parent: "r",
      q: text,
      ...(quote ? { quote: quote.text.slice(0, 2000), b: quote.b ?? undefined } : {}),
      model: choice.model,
      effort: choice.effort,
    });
    if (id) select(thread.id, id);
    return id !== null;
  };

  return (
    <div
      ref={pinned}
      className="pinned"
      style={layout.height ? { minHeight: layout.height } : undefined}
    >
      {rootAsk ? (
        <div className="pin" style={style(0)}>
          {quote ? (
            <div className="bqw">
              {quote.text.length > 180 && !quote.open ? (
                <button
                  type="button"
                  className="bq bqx"
                  aria-label="Show the whole quote"
                  onClick={() =>
                    open(thread.id, { ...rootAsk, quote: { ...quote, open: true } }, null)
                  }
                >
                  {clip(quote.text, 180)}
                  <span className="bqm">Show all</span>
                </button>
              ) : (
                <blockquote className="bq full">{quote.text}</blockquote>
              )}
              <button
                type="button"
                className="ibtn bqc"
                aria-label="Close"
                title="Close"
                onClick={() => {
                  close(thread.id);
                  focusSoon(selectedRowOr(thread.id, `#card-${thread.id} .rcount`));
                }}
              >
                <CloseIcon />
              </button>
            </div>
          ) : null}
          <InlineComposer
            key={composerKey(thread.id, rootAsk) + (quote ? ":q" : "")}
            draftKey={composerKey(thread.id, rootAsk)}
            placeholder={quote ? "Ask about this passage" : "Ask about the answer"}
            submitLabel="Ask"
            onSubmit={submitRoot}
            onClose={() => close(thread.id)}
            showClose={!quote}
            returnFocus={selectedRowOr(thread.id, `#card-${thread.id} .rcount`)}
          />
        </div>
      ) : null}
      {trees.map((tree, i) => {
        const at = i + (rootAsk ? 1 : 0);
        const inGroup = ui.selected !== null && tree.nodes.some((n) => selectedPath.has(n.id));
        const selected = inGroup && ui.selected ? index.nodes.get(ui.selected) : undefined;
        return (
          <div
            key={tree.b}
            className={cn("pin grp", hovered === tree.b && "hl")}
            data-grp-box={tree.b}
            style={style(at)}
            onMouseEnter={() => onHover(tree.b)}
            onMouseLeave={() => onHover(null)}
          >
            <BranchOutline
              tree={tree}
              index={index}
              threadAuthor={thread.u ?? ""}
              selected={ui.selected}
              path={selectedPath}
              onSelect={(id) => toggle(thread.id, id)}
            />
            {selected ? (
              <BranchCard
                key={selected.id}
                thread={thread.id}
                node={selected}
                index={index}
                channel={channel}
                now={now}
                onSelect={(id) => select(thread.id, id)}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function rowContent(node: NodeRec, parentAuthor: string) {
  return (
    <>
      {node.look !== null ? (
        <span className="gq glook" title="Look up">
          <SearchIcon />
          <span className="sr-only">Look up </span>
          {node.look}
        </span>
      ) : (
        <span className="gq">{rowText(node, node.q)}</span>
      )}
      {node.u !== parentAuthor ? (
        <span className="rav rav-r" title={node.u}>
          <Avatar handle={node.u} size="xs" />
          <span className="sr-only">, by {node.u}</span>
        </span>
      ) : null}
    </>
  );
}

/** One passage's tree (`outline`). */
export function BranchOutline({
  tree,
  index,
  threadAuthor,
  selected,
  path,
  onSelect,
}: {
  tree: PassageTree;
  index: TreeIndex;
  threadAuthor: string;
  selected: string | null;
  path: ReadonlySet<string>;
  onSelect: (id: string) => void;
}) {
  const rows: TreeRow[] = [];
  for (const top of tree.nodes)
    for (const { node, depth } of index.dfs(top.id)) {
      const parentAuthor = node.par === "r" ? threadAuthor : (index.nodes.get(node.par)?.u ?? "");
      rows.push({
        id: node.id,
        parent: depth === 0 ? null : node.par,
        depth,
        on: path.has(node.id),
        selected: node.id === selected,
        content: rowContent(node, parentAuthor),
      });
    }
  return (
    <TreeRail
      rows={rows}
      label="Branches on this passage"
      onSelect={onSelect}
      layoutKey={`${selected ?? ""}`}
    />
  );
}
