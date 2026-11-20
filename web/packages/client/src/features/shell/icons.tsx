// The members mockup's icons (`I`, `SCOPE_IC`, `LAY_EXPAND`, …): 16-unit
// strokes at 1.5, drawn in `currentColor`. They are the mockup's paths, so
// the shell matches it; lucide-react stays the icon set of the rest of the
// client.

import type { SVGProps } from "react";

type IconProps = Omit<SVGProps<SVGSVGElement>, "viewBox"> & { size?: number };

function Icon({ size = 14, children, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
      className={`shrink-0 ${props.className ?? ""}`}
    >
      {children}
    </svg>
  );
}

/** The agent mark inside the brand tile. */
export function AgentIcon({ size = 12 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="8" cy="8" r="5.5" />
      <circle cx="8" cy="8" r="1.8" fill="currentColor" stroke="none" />
    </svg>
  );
}

export const ChevronDownIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4.5 6.5 8 10l3.5-3.5" />
  </Icon>
);

export const CheckIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M3.5 8.5l3 3 6-7" />
  </Icon>
);

export const PlusIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M8 3.5v9M3.5 8h9" />
  </Icon>
);

/** Bookmark; filled where the mock fills it (a non-zero Saved count). */
export const BookmarkIcon = ({ filled = false, ...props }: IconProps & { filled?: boolean }) => (
  <Icon {...props} fill={filled ? "currentColor" : "none"}>
    <path d="M4 2.5h8v11l-4-2.8-4 2.8z" />
  </Icon>
);

/** Layout `centred` → `wide`: arrows outward. */
export const ExpandIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9" />
  </Icon>
);

/** Layout `wide` → `centred`: arrows inward. */
export const CollapseIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M13.5 2.5 9 7M9 3v4h4M2.5 13.5 7 9M7 13V9H3" />
  </Icon>
);

/** Scope Joined. */
export const CheckCircleIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="8" cy="8" r="5.75" />
    <path d="m5.6 8.2 1.7 1.7 3.2-3.6" />
  </Icon>
);

/** Scope "Channels you manage". */
export const PersonIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="8" cy="5.6" r="2.6" />
    <path d="M3 13.5c.5-2.6 2.6-4 5-4s4.5 1.4 5 4" />
  </Icon>
);

/** Scope All. */
export const CompassIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="8" cy="8" r="6" />
    <path d="m10.4 5.6-1.3 3.5-3.5 1.3 1.3-3.5Z" />
  </Icon>
);
