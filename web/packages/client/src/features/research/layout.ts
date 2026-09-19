// The document's two-column geometry (`09-research-document-view.md` §3).
//
// Everything here is pure: the view measures rects, these functions decide
// where a card sits and how a connector is routed, and the tests exercise them
// without a layout engine. The constants are the desktop's, carried over so
// the arrangement is pixel-identical.

/** Minimum vertical gap between anchored cards after collision resolution.
 * Tighter than the stacked rail's 20 px so a cascaded cluster stays visually
 * attached to the passage that produced it. */
export const ANCHORED_CARD_GAP = 12;

/** Clearance between the docked ask composer's bottom edge and the first card
 * it pushes down. */
export const ASK_COMPOSER_CLEARANCE = 20;

/** A connector's vertical run may be displaced at most this fraction of its
 * own horizontal span from the centered midline. */
export const CONNECTOR_STAGGER_FRACTION = 0.25;

/** Pixel separation between adjacent lanes of overlapping vertical runs. */
export const CONNECTOR_STAGGER_STEP = 14;

/** Nearly touching vertical spans count as competing routes, so the later one
 * takes an elbow instead of crossing the earlier leader. */
export const CONNECTOR_COLLISION_CLEARANCE = 8;

/** Trailing debounce on reflow before passage, card and connector geometry is
 * remeasured: a drag would otherwise force layout on every frame. */
export const ANCHOR_LAYOUT_DEBOUNCE_MS = 140;

/** The platform's click-versus-drag tolerance. Below it a press keeps native
 * click, link and double-click behavior; above it the drag switches to live
 * whole-word selection. */
export const RESEARCH_SELECTION_DRAG_THRESHOLD = 3;

/** Characters of context stored on each side of a highlight anchor. */
export const RESEARCH_HIGHLIGHT_CONTEXT_LENGTH = 128;

/** Timeline items rendered before the "Show N earlier" expander appears. */
export const TIMELINE_ITEM_RENDER_WINDOW = 100;

/** The answer column's cap. Declared as a custom property on the document
 * content root and consumed by the grid, so the number lives in one place
 * (the desktop spelled it literally at four sites to work around a WebKit
 * `var()` bug that the web does not have — 09 §3). */
export const RESEARCH_ANSWER_MAX_WIDTH = "640px";

/** The document's two columns: the answer column, capped at
 * `--research-answer-max-width`, and the follow-up rail. Every row of a
 * segment (prompt, answer, trailing composer) lays out on this grid so the
 * prompt and the answer wrap at the same edge whatever the viewport; under
 * 900px the rail drops beneath and the one column takes the width. */
export const RESEARCH_COLUMNS_CLASS =
  "grid grid-cols-[minmax(0,var(--research-answer-max-width))_minmax(220px,260px)] " +
  "gap-(--research-column-gap) max-[900px]:grid-cols-[minmax(0,1fr)]";

export interface AnchoredCardPlacement {
  id: string;
  /** Where the card wants to sit: the passage's top, relative to the rail. */
  desiredTop: number;
  /** Measured rendered height. */
  height: number;
}

/**
 * One-pass collision resolution for a rail's anchored cards: place them in
 * desired-top order, each no higher than the previous card's bottom plus a gap.
 *
 * Heights depend only on card content — never on the tops this assigns — so a
 * single downward pass settles the layout with no feedback loop. Ties break on
 * id so equal desired tops keep a stable order across renders.
 */
export function resolveAnchoredCardTops(
  placements: readonly AnchoredCardPlacement[],
  gap = ANCHORED_CARD_GAP,
): Record<string, number> {
  const ordered = [...placements].sort(
    (left, right) => left.desiredTop - right.desiredTop || left.id.localeCompare(right.id),
  );
  const tops: Record<string, number> = {};
  let cursor = Number.NEGATIVE_INFINITY;
  for (const placement of ordered) {
    const top = Math.max(placement.desiredTop, cursor);
    tops[placement.id] = top;
    cursor = top + placement.height + gap;
  }
  return tops;
}

export interface ConnectorGeometry {
  id: string;
  /** Passage edge. */
  sx: number;
  sy: number;
  /** Card edge. */
  ex: number;
  ey: number;
}

/**
 * Greedy interval coloring over the connectors' vertical spans, top to bottom.
 *
 * A direct leader normally stays in lane 0. When two runs would sit on top of
 * one another the later one takes the lowest lane that is free, and Route connector lines with elbow curves only when cards overlap to avoid collisions.
 *
 * Returns the lane per connector, in the input's order.
 */
export function assignConnectorLanes(
  geometry: readonly ConnectorGeometry[],
  clearance = CONNECTOR_COLLISION_CLEARANCE,
): number[] {
  const lanes: number[] = [];
  const laneByIndex = new Array<number>(geometry.length).fill(0);
  geometry
    .map((connector, index) => ({
      index,
      top: Math.min(connector.sy, connector.ey),
      bottom: Math.max(connector.sy, connector.ey),
    }))
    .sort((left, right) => left.top - right.top || left.index - right.index)
    .forEach(({ index, top, bottom }) => {
      let lane = lanes.findIndex((occupiedUntil) => occupiedUntil + clearance <= top);
      if (lane === -1) lane = lanes.length;
      lanes[lane] = bottom;
      laneByIndex[index] = lane;
    });
  return laneByIndex;
}

/**
 * Rounded-elbow path: out of the passage's line into the gutter, a vertical run
 * at `midX`, then into the card at the card's own height. Degenerates to a
 * straight segment when the pair is level or the gutter is too tight to turn
 * in.
 */
export function connectorElbowPath(
  sx: number,
  sy: number,
  ex: number,
  ey: number,
  midX = Math.round((sx + ex) / 2),
): string {
  const dy = ey - sy;
  if (Math.abs(dy) < 2 || ex - sx < 8) return `M ${sx} ${sy} L ${ex} ${ey}`;
  const radius = Math.min(10, Math.abs(dy) / 2, midX - sx, ex - midX);
  const direction = dy > 0 ? 1 : -1;
  return (
    `M ${sx} ${sy} L ${midX - radius} ${sy}` +
    ` Q ${midX} ${sy} ${midX} ${sy + direction * radius}` +
    ` L ${midX} ${ey - direction * radius}` +
    ` Q ${midX} ${ey} ${midX + radius} ${ey}` +
    ` L ${ex} ${ey}`
  );
}

export interface SegmentConnector {
  segmentId: string;
  /** The follow-up node the leader points at. */
  id: string;
  d: string;
  /** Endpoint dot, in the segment grid's pixel coordinates. */
  x: number;
  y: number;
}

/** Lane assignment plus path construction for one segment's connectors. */
export function buildSegmentConnectors(
  segmentId: string,
  geometry: readonly ConnectorGeometry[],
): SegmentConnector[] {
  const lanes = assignConnectorLanes(geometry);
  return geometry.map((connector, index) => {
    const lane = lanes[index] ?? 0;
    const maxOffset = CONNECTOR_STAGGER_FRACTION * (connector.ex - connector.sx);
    const offset = Math.min(lane * CONNECTOR_STAGGER_STEP, maxOffset);
    const midX = Math.round((connector.sx + connector.ex) / 2 - offset);
    return {
      segmentId,
      id: connector.id,
      d:
        lane === 0
          ? `M ${connector.sx} ${connector.sy} L ${connector.ex} ${connector.ey}`
          : connectorElbowPath(connector.sx, connector.sy, connector.ex, connector.ey, midX),
      x: connector.sx,
      y: connector.sy,
    };
  });
}

/** Shallow equality over a record of card offsets, used to keep the previous
 * state identity when a remeasure finds nothing moved. */
export function sameCardTops(left: Record<string, number>, right: Record<string, number>): boolean {
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key]);
}
