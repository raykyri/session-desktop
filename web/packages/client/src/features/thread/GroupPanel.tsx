// The open thread's Home group at the top of its messages column, ported from
// the desktop `ResearchGroupPanel.tsx`: for a parent, "In this group" with a
// row per child listed under it in Home; for a child, a link to its parent.

import type { ResearchRowKind, ResearchRowState } from "@session/shared/lib/researchRowGlyph";
import { CornerLeftUp } from "lucide-react";
import { useId } from "react";

import { cn } from "../../lib/cn.js";
import { RowGlyph } from "../../ui/RowGlyph.js";
import { FOCUS_RING } from "../../ui/surfaces.js";

/** The Home group of the open thread: as a parent, the children listed under
 * it; as a child, its parent. */
export interface ThreadGroup {
  parent: { id: string; title: string } | null;
  children: {
    id: string;
    title: string;
    kind: ResearchRowKind;
    state: ResearchRowState;
    unread: boolean;
  }[];
}

const ROW = cn(
  "text-fg-secondary hover:bg-surface-fill-hover hover:text-fg-heading flex w-full min-w-0 items-start gap-1.5 rounded-md border-0 bg-transparent px-1.5 py-1 text-left font-[inherit]",
  FOCUS_RING,
);

export function GroupPanel({
  group,
  onOpen,
}: {
  group: ThreadGroup;
  onOpen: (treeId: string) => void;
}) {
  const headingId = useId();
  const frame =
    "border-border-divider border-b px-3.5 pt-2.5 pb-2 text-[length:calc(12.5px+var(--font-ui-size-offset))] leading-[1.45]";
  if (group.parent) {
    const parent = group.parent;
    return (
      <nav className={frame} aria-label="Parent thread" data-research-group-panel="">
        <button
          type="button"
          className={cn(ROW, "text-fg-muted")}
          onClick={() => onOpen(parent.id)}
        >
          <CornerLeftUp size={13} className="text-fg-faint mt-[3px] shrink-0" aria-hidden="true" />
          <span className="min-w-0 truncate">In “{parent.title}”</span>
        </button>
      </nav>
    );
  }
  if (group.children.length === 0) return null;
  return (
    <nav className={frame} aria-labelledby={headingId} data-research-group-panel="">
      <h3
        id={headingId}
        className="text-fg-faint m-0 mb-1 ml-1.5 text-xs font-semibold tracking-wide uppercase"
      >
        In this group · {group.children.length}
      </h3>
      <ul className="m-0 list-none p-0">
        {group.children.map((child) => (
          <li key={child.id}>
            <button type="button" className={ROW} onClick={() => onOpen(child.id)}>
              <RowGlyph
                kind={child.kind}
                state={child.state}
                unread={child.unread}
                className="mt-[3px] shrink-0"
              />
              <span className="min-w-0 truncate">{child.title}</span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
