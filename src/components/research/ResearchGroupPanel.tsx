import { useId } from "react";
import { CornerLeftUp } from "lucide-react";
import type { ResearchRowKind, ResearchRowState } from "@session/shared/lib/researchRowGlyph";
import ResearchRowGlyph from "./ResearchRowGlyph";

/** The Home group of the open thread: as a parent, the children listed under
 * it; as a child, its parent. */
export interface ResearchThreadGroup {
  parent: { id: string; title: string } | null;
  children: {
    id: string;
    title: string;
    kind: ResearchRowKind;
    state: ResearchRowState;
    unread: boolean;
  }[];
}

/** The top of a thread's messages column when the thread is in a group:
 * "In this group" with a row per child that opens it, or for a child a link
 * to its parent. */
export default function ResearchGroupPanel({
  group,
  onOpen,
}: {
  group: ResearchThreadGroup;
  onOpen: (treeId: string) => void;
}) {
  const headingId = useId();
  if (group.parent) {
    const parent = group.parent;
    return (
      <nav className="research-group-panel" aria-label="Parent thread">
        <button type="button" className="research-group-panel-parent" onClick={() => onOpen(parent.id)}>
          <CornerLeftUp size={13} aria-hidden="true" />
          <span className="research-group-panel-title">In “{parent.title}”</span>
        </button>
      </nav>
    );
  }
  if (group.children.length === 0) return null;
  return (
    <nav className="research-group-panel" aria-labelledby={headingId}>
      <h3 id={headingId} className="research-group-panel-heading">
        In this group · {group.children.length}
      </h3>
      <ul>
        {group.children.map((child) => (
          <li key={child.id}>
            <button type="button" className="research-group-panel-row" onClick={() => onOpen(child.id)}>
              <ResearchRowGlyph kind={child.kind} state={child.state} unread={child.unread} />
              <span className="research-group-panel-title">{child.title}</span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
