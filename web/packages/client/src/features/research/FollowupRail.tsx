// The margin rail beside an answer (`09-research-document-view.md` §2, §3).
//
// Branch follow-ups appear here as cards. A branch with a `queryAnchor` whose
// passage still resolves is *anchored*: it is positioned absolutely at the
// passage's own vertical offset and joined to it by a dotted leader. Everything
// else stacks in normal flow at the top of the rail. The docked ask composer,
// when one is open on this segment, is rendered by the page and slotted in
// here.

import type { ResearchNode } from "@session/shared";
import { LoaderCircle } from "lucide-react";
import { memo } from "react";
import type { ReactNode } from "react";

import { cn } from "../../lib/cn.js";
import { ResearchMarkdown } from "../markdown/index.js";

import type { SegmentConnector } from "./layout.js";
import { statusLabel } from "./timeline.js";

const CARD =
  "relative flex w-full flex-col items-stretch gap-1 rounded-lg border border-transparent " +
  "bg-transparent p-0 text-left transition-transform duration-[350ms] " +
  "focus-visible:ring-2 focus-visible:ring-focus-ring outline-none";

const ANCHORED_CARD =
  "absolute right-0.5 left-0 z-[1] border-border-subtle bg-surface-card px-3 py-2.5 " +
  "hover:z-[4] hover:border-border-default max-[900px]:static";

export const ConnectorOverlay = memo(
  function ConnectorOverlay({
    connectors,
    linkedAnchorId,
  }: {
    connectors: readonly SegmentConnector[];
    linkedAnchorId: string | null;
  }) {
    if (connectors.length === 0) return null;
    return (
      <svg
        className="pointer-events-none absolute inset-0 h-full w-full overflow-visible max-[900px]:hidden"
        aria-hidden="true"
      >
        {connectors.map((connector) => (
          <g
            key={connector.id}
            className={cn(
              "transition-opacity duration-[120ms]",
              linkedAnchorId === connector.id ? "opacity-100" : "opacity-55",
            )}
          >
            <path
              d={connector.d}
              fill="none"
              stroke="currentColor"
              strokeDasharray="2 5"
              className="text-fg-faint"
            />
            <circle
              cx={connector.x}
              cy={connector.y}
              r={2}
              fill="currentColor"
              className="text-fg-faint"
            />
          </g>
        ))}
      </svg>
    );
  },
  (previous, next) =>
    previous.linkedAnchorId === next.linkedAnchorId &&
    previous.connectors.length === next.connectors.length &&
    previous.connectors.every((connector, index) => {
      const candidate = next.connectors[index];
      return (
        candidate !== undefined &&
        connector.id === candidate.id &&
        connector.d === candidate.d &&
        connector.x === candidate.x &&
        connector.y === candidate.y
      );
    }),
);

export interface FollowupRailProps {
  nodeId: string;
  cards: readonly ResearchNode[];
  /** IDs of follow-up nodes that finished while this page was active and have not
   * been opened. */
  unreadIds: ReadonlySet<string>;
  /** The anchored card currently hover-linked to its passage, from either end. */
  linkedAnchorId: string | null;
  /** Desired offsets, keyed by child id; membership marks a card as anchored. */
  anchoredCardTops: Record<string, number>;
  /** Collision-resolved offsets derived from those and the rendered heights. */
  resolvedCardTops: Record<string, number>;
  askComposer: ReactNode;
  registerAside: (element: HTMLElement | null) => void;
  onSelectNode: (nodeId: string) => void;
  onCardHover: (childId: string, entering: boolean) => void;
}

export const FollowupRail = memo(function FollowupRail({
  nodeId,
  cards,
  unreadIds,
  linkedAnchorId,
  anchoredCardTops,
  resolvedCardTops,
  askComposer,
  registerAside,
  onSelectNode,
  onCardHover,
}: FollowupRailProps) {
  const stacked = cards.filter((child) => anchoredCardTops[child.id] === undefined);
  const anchored = cards
    .filter((child) => anchoredCardTops[child.id] !== undefined)
    .map((child) => ({
      child,
      top: resolvedCardTops[child.id] ?? anchoredCardTops[child.id] ?? 0,
    }))
    .sort((left, right) => left.top - right.top);

  // A card keeps its `queryAnchor` for placement and hover-linking, but the
  // quoted passage itself appears only once the follow-up is opened, above its
  // question in the answer column.
  const renderCard = (child: ResearchNode, anchoredTop?: number) => {
    const unread = unreadIds.has(child.id);
    return (
      <button
        key={child.id}
        type="button"
        className={cn(
          CARD,
          anchoredTop !== undefined && ANCHORED_CARD,
          linkedAnchorId === child.id && "border-border-default z-[4]",
        )}
        style={anchoredTop === undefined ? undefined : { top: anchoredTop }}
        data-node-id={child.id}
        data-research-card-node-id={child.id}
        onClick={() => onSelectNode(child.id)}
        onMouseEnter={child.queryAnchor ? () => onCardHover(child.id, true) : undefined}
        onMouseLeave={child.queryAnchor ? () => onCardHover(child.id, false) : undefined}
      >
        {unread ? (
          <span
            className="bg-accent pointer-events-none absolute top-[3px] right-0 size-1.5 rounded-full"
            aria-label="Unread response"
          />
        ) : null}
        <strong className="text-fg-interactive min-w-0 text-sm leading-snug">{child.prompt}</strong>
        {child.responsePreview ? (
          <ResearchMarkdown
            markdown={child.responsePreview}
            variant="compact"
            inline
            className="line-clamp-4"
          />
        ) : null}
        {child.status !== "complete" ? (
          <small
            className={cn(
              "text-fg-faint flex items-center gap-1 text-xs",
              child.status === "failed" && "text-status-failed",
            )}
          >
            {child.status === "running" ? (
              <LoaderCircle className="session-spin" size={11} aria-hidden="true" />
            ) : null}
            {statusLabel(child.status)}
          </small>
        ) : null}
      </button>
    );
  };

  return (
    <aside
      ref={registerAside}
      className="border-border-subtle relative mt-0.5 flex min-w-0 flex-col gap-4 pr-0.5 max-[900px]:border-t max-[900px]:pt-7"
      data-node-id={nodeId}
      aria-label="Follow-ups"
    >
      {askComposer}
      <div className="flex flex-col gap-4">{stacked.map((child) => renderCard(child))}</div>
      {anchored.map(({ child, top }) => renderCard(child, top))}
    </aside>
  );
});
