// Seam for the Markdown renderer (`08-design-system-and-styling.md` §5).
// The research document track replaces this file with the full
// react-markdown pipeline; other views import `ResearchMarkdown` from here and
// keep working when the real renderer lands.

export interface ResearchMarkdownProps {
  markdown: string;
  /** `prose` for answers, `summary` for recap text, `compact` for previews. */
  variant?: "prose" | "summary" | "compact";
  className?: string;
}

const VARIANT_CLASS: Record<NonNullable<ResearchMarkdownProps["variant"]>, string> = {
  prose: "research-prose",
  summary: "research-summary-text",
  compact: "research-prose research-prose--compact",
};

export function ResearchMarkdown({
  markdown,
  variant = "prose",
  className,
}: ResearchMarkdownProps) {
  const classes = className ? `${VARIANT_CLASS[variant]} ${className}` : VARIANT_CLASS[variant];
  return <div className={classes}>{markdown}</div>;
}
