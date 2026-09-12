import type { ResearchNodeContent } from "../../types";

/** No placeholder or reserved space: mount only a completed, current recap. */
export default function ResearchRecap({ content }: { content: ResearchNodeContent }) {
  const { node, responseRevision } = content;
  const recap = node.recap;
  if (
    (node.kind ?? "run") !== "run" ||
    node.status !== "complete" ||
    !recap?.text.trim() ||
    !responseRevision ||
    recap.responseRevision !== responseRevision
  ) {
    return null;
  }
  return <p className="research-recap">Summary: {recap.text}</p>;
}
