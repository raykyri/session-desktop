// A tree drawn on a rail (02 §4.1, §4.3; the mock's `outline`, `replyLines`
// and `drawGraph`): one button per row, indented 13 px per level, and an SVG
// rail measured after layout, so a dot stays on its row's first line when
// the row wraps. The tree is one tab stop (roving `tabindex`); Up and Down
// move, Left goes to the parent, Right to the first child, Enter or Space
// selects (02 §10.1).

import type { KeyboardEvent, ReactNode } from "react";
import { useLayoutEffect, useRef, useState } from "react";

import { cn } from "../../lib/cn.js";

import { railGeometry, railX, type RailDot, type RailPath } from "./geometry.js";

export interface TreeRow {
  id: string;
  parent: string | null;
  depth: number;
  on: boolean;
  selected: boolean;
  content: ReactNode;
  /** `aria-expanded` of a collapsible row. */
  expanded?: boolean | undefined;
  className?: string | undefined;
}

export interface TreeRailProps {
  rows: readonly TreeRow[];
  label: string;
  onSelect: (id: string) => void;
  /** A value that changes when the rows' layout may (wrapping, selection). */
  layoutKey?: string;
  /** The selector of a row's first-line element (`.gq`, or `.gq-av` for
   * avatar rows, whose centre is the row's). */
  lineSelector?: string;
}

function sameGeometry(
  a: { paths: RailPath[]; dots: RailDot[]; height: number },
  b: { paths: RailPath[]; dots: RailDot[]; height: number },
) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function TreeRail({
  rows,
  label,
  onSelect,
  layoutKey,
  lineSelector = ".gq",
}: TreeRailProps) {
  const graph = useRef<HTMLDivElement>(null);
  const [geometry, setGeometry] = useState<{
    paths: RailPath[];
    dots: RailDot[];
    height: number;
  }>({ paths: [], dots: [], height: 0 });
  const [focusId, setFocusId] = useState<string | null>(null);

  useLayoutEffect(() => {
    const el = graph.current;
    if (!el) return;
    const measure = () => {
      const measured = rows.map((row) => {
        const button = el.querySelector<HTMLElement>(`[data-row="${CSS.escape(row.id)}"]`);
        const line = button?.querySelector<HTMLElement>(lineSelector);
        let y = 13;
        if (button && line) {
          const centre = line.classList.contains("gq-av")
            ? line.offsetHeight / 2
            : parseFloat(getComputedStyle(line).lineHeight) / 2 || 13;
          y = button.offsetTop + line.offsetTop + centre;
        } else if (button) y = button.offsetTop + 13;
        return {
          id: row.id,
          parent: row.parent,
          depth: row.depth,
          y,
          on: row.on,
          selected: row.selected,
        };
      });
      const next = { ...railGeometry(measured), height: el.offsetHeight };
      setGeometry((prev) => (sameGeometry(prev, next) ? prev : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [rows, layoutKey, lineSelector]);

  const tabStop = focusId ?? rows.find((r) => r.selected)?.id ?? rows[0]?.id ?? null;

  const move = (event: KeyboardEvent<HTMLButtonElement>, row: TreeRow, index: number) => {
    let target: TreeRow | undefined;
    if (event.key === "ArrowDown") target = rows[index + 1];
    else if (event.key === "ArrowUp") target = rows[index - 1];
    else if (event.key === "ArrowLeft") target = rows.find((r) => r.id === row.parent);
    else if (event.key === "ArrowRight") target = rows.find((r) => r.parent === row.id);
    else if (event.key === "Home") target = rows[0];
    else if (event.key === "End") target = rows[rows.length - 1];
    else return;
    event.preventDefault();
    if (!target) return;
    setFocusId(target.id);
    graph.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(target.id)}"]`)?.focus();
  };

  return (
    <div ref={graph} className="graph" role="tree" aria-label={label}>
      <svg className="rail" aria-hidden="true" height={geometry.height}>
        {geometry.paths.map((p, i) => (
          <path key={`p${i}`} className={p.on ? "on" : undefined} d={p.d} />
        ))}
        {geometry.dots.map((d, i) => (
          <circle key={`d${i}`} className={d.state || undefined} cx={d.cx} cy={d.cy} r={3.5} />
        ))}
      </svg>
      {rows.map((row, index) => (
        <button
          key={row.id}
          type="button"
          role="treeitem"
          data-row={row.id}
          data-depth={row.depth}
          aria-level={row.depth + 1}
          aria-selected={row.selected}
          {...(row.expanded !== undefined ? { "aria-expanded": row.expanded } : {})}
          tabIndex={row.id === tabStop ? 0 : -1}
          className={cn("grow-r", row.on && "on", row.selected && "sel", row.className)}
          style={{ paddingLeft: railX(row.depth) + 10 }}
          onFocus={() => setFocusId(row.id)}
          onClick={() => onSelect(row.id)}
          onKeyDown={(event) => move(event, row, index)}
        >
          {row.content}
        </button>
      ))}
    </div>
  );
}
