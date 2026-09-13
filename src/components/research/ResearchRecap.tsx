import type { ResearchNodeContent } from "../../types";

export function ResearchRecapLine({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  return (
    <p className={className ? `research-recap ${className}` : "research-recap"}>
      Summary: {trimmed}
    </p>
  );
}

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
  return <ResearchRecapLine text={recap.text} />;
}
