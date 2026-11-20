// A document's answer column while its editor holds unsaved text
// (`09-research-document-view.md` §8), ported from the desktop
// `ResearchEditPreview`: the new text rendered block by block, each block not
// in the saved text marked as changed.

import { stripImportedReportCitations } from "@session/shared/lib/researchDocuments";
import { editedMarkdownBlocks } from "@session/shared/lib/researchEditor";
import { Eye } from "lucide-react";
import { memo, useMemo } from "react";

import { cn } from "../../lib/cn.js";
import { ResearchMarkdown } from "../markdown/index.js";

export const EditPreview = memo(function EditPreview({
  original,
  next,
  imported = false,
  label,
}: {
  original: string;
  next: string;
  imported?: boolean;
  label: string;
}) {
  const blocks = useMemo(() => {
    const seen = new Map<string, number>();
    return editedMarkdownBlocks(original, next).map((block) => {
      const repeat = seen.get(block.text) ?? 0;
      seen.set(block.text, repeat + 1);
      return { ...block, key: `${repeat}:${block.text}` };
    });
  }, [original, next]);
  const changed = blocks.filter((block) => block.changed).length;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-fg-muted m-0 mb-2 flex items-center gap-1.5 text-sm">
        <Eye size={13} aria-hidden="true" />
        <span>
          {`${label} · ${
            changed === 0
              ? "no paragraphs changed"
              : changed === 1
                ? "1 paragraph changed"
                : `${changed} paragraphs changed`
          }`}
        </span>
      </p>
      {blocks.map((block) => (
        <PreviewBlock
          key={block.key}
          text={imported ? stripImportedReportCitations(block.text) : block.text}
          changed={block.changed}
        />
      ))}
    </div>
  );
});

const PreviewBlock = memo(function PreviewBlock({
  text,
  changed,
}: {
  text: string;
  changed: boolean;
}) {
  return (
    <div className={cn(changed && "border-accent -ml-3 border-l-2 pl-2.5")}>
      {changed ? <span className="sr-only">Changed: </span> : null}
      <ResearchMarkdown markdown={text} />
    </div>
  );
});
