// Pure geometry of the side column (02 W4.1): the rail of a branch or reply
// tree (`drawGraph`) and the placement of one tree per passage (`place`).

/** A tree row as measured after layout. `y` is the centre of its first line,
 * relative to the tree's top (also when the row wraps). */
export interface RailRow {
  id: string;
  parent: string | null;
  depth: number;
  y: number;
  on: boolean;
  selected: boolean;
}

export interface RailPath {
  d: string;
  on: boolean;
}

export interface RailDot {
  cx: number;
  cy: number;
  state: "" | "on" | "sel";
}

/** The x of a row's dot: 10 px, and 13 px further per level. */
export const railX = (depth: number) => 10 + depth * 13;

/** From the parent's dot straight down, a 6 px rounded corner, into the
 * child's dot; 3.5 px dots on every row. Rows come in display order, so a
 * parent is always before its children. */
export function railGeometry(rows: readonly RailRow[]): { paths: RailPath[]; dots: RailDot[] } {
  const at = new Map<string, { x: number; y: number }>();
  const paths: RailPath[] = [];
  const dots: RailDot[] = [];
  for (const row of rows) {
    const x = railX(row.depth);
    at.set(row.id, { x, y: row.y });
    const parent = row.parent === null ? undefined : at.get(row.parent);
    if (parent)
      paths.push({
        d: `M${parent.x} ${parent.y} L${parent.x} ${row.y - 6} Q${parent.x} ${row.y} ${parent.x + 6} ${row.y} L${x} ${row.y}`,
        on: row.on,
      });
    dots.push({ cx: x, cy: row.y, state: row.selected ? "sel" : row.on ? "on" : "" });
  }
  return { paths, dots };
}

/** Places items at their anchors' heights in reading order, each at least
 * `gap` below the one above; returns each item's top and the height the
 * column needs. Anchors are relative to the column's top. */
export function placePins(
  items: readonly { anchor: number; height: number }[],
  gap = 12,
): { tops: number[]; height: number } {
  const order = items.map((item, i) => ({ ...item, i })).sort((a, b) => a.anchor - b.anchor);
  const tops = new Array<number>(items.length).fill(0);
  let y = 0;
  for (const item of order) {
    const top = Math.max(item.anchor, y);
    tops[item.i] = top;
    y = top + item.height + gap;
  }
  return { tops, height: y };
}
