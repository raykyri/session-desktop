/** The research UI's branch glyph, drawn as in the design mock: a trunk, two
 * nodes and the curve between them (lucide's GitBranch draws the curve the
 * other way round). Used wherever a branch shows: the question meta row, the
 * branch and passage menus, the selection actions and feed child rows. */
export function ResearchBranchIcon({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 3v12" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  );
}
