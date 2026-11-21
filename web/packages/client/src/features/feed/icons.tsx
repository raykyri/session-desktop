// The feed's icons, the members mockup's paths (`I`, `ARROW_REPLY`,
// `BRANCH_IC`, `CONT_IC`, `BUBBLE`, `PENCIL`, `ARROW_SEND`, `SEARCH`,
// `INFO_IC`, `LOCK`, `RM_IC`, `EMPTY_SAVE`): 16-unit strokes sized by the
// `svg.i` rule of `spaces.css` and the rule of the control that holds them.

import type { ReactNode } from "react";

function I({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <svg
      className="i"
      viewBox="0 0 16 16"
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const ReplyArrowIcon = () => (
  <I>
    <path d="M6.5 4 3 7.5 6.5 11" />
    <path d="M3.5 7.5h5.5a4 4 0 0 1 4 4v1" />
  </I>
);

export const SaveIcon = () => (
  <I>
    <path d="M4 2.5h8v11l-4-2.8-4 2.8z" />
  </I>
);

export const DotsIcon = () => (
  <I>
    <circle cx="3.5" cy="8" r="1.25" fill="currentColor" stroke="none" />
    <circle cx="8" cy="8" r="1.25" fill="currentColor" stroke="none" />
    <circle cx="12.5" cy="8" r="1.25" fill="currentColor" stroke="none" />
  </I>
);

export const CloseIcon = () => (
  <I>
    <path d="M4 4l8 8M12 4l-8 8" />
  </I>
);

export const SearchIcon = () => (
  <I>
    <circle cx="7" cy="7" r="4.5" />
    <path d="m10.5 10.5 3 3" />
  </I>
);

/** Branch: asks beside this answer (down and to the right). */
export const BranchIcon = () => (
  <I>
    <path d="M4 3v5a2 2 0 0 0 2 2h6" />
    <path d="M9.5 7.5 12 10l-2.5 2.5" />
  </I>
);

/** Continue: asks under this answer (down). */
export const ContinueIcon = () => (
  <I>
    <path d="M8 3v10" />
    <path d="M4 9l4 4 4-4" />
  </I>
);

export const BubbleIcon = () => (
  <I>
    <path d="M3 4.5A1.5 1.5 0 0 1 4.5 3h7A1.5 1.5 0 0 1 13 4.5v5a1.5 1.5 0 0 1-1.5 1.5H7l-3 2.5V11h0.5A1.5 1.5 0 0 1 3 9.5Z" />
  </I>
);

export const PencilIcon = () => (
  <I>
    <path d="M10.8 2.7a1.6 1.6 0 0 1 2.3 2.3L5.6 12.5 2.5 13.5l1-3.1Z" />
    <path d="M9.6 3.9l2.3 2.3" />
  </I>
);

export const SendArrowIcon = () => (
  <I>
    <path d="M3 8h10" />
    <path d="M8.5 3.5 13 8l-4.5 4.5" />
  </I>
);

export const ChevronDown = () => (
  <I>
    <path d="M4.5 6.5 8 10l3.5-3.5" />
  </I>
);

export const ChevronRight = () => (
  <I>
    <path d="M6 3.5L10.5 8 6 12.5" />
  </I>
);

export const CheckMark = () => (
  <I>
    <path d="M3.5 8.5l3 3 6-7" />
  </I>
);

export const InfoIcon = () => (
  <I>
    <circle cx="8" cy="8" r="6" />
    <path d="M8 7.2v3.8" />
    <circle cx="8" cy="5" r=".95" fill="currentColor" stroke="none" />
  </I>
);

export function LockIcon() {
  return (
    <svg className="i lock" viewBox="0 0 16 16" role="img" aria-label="Private">
      <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" />
      <path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7" />
    </svg>
  );
}

export const RemovedIcon = () => (
  <I>
    <circle cx="8" cy="8" r="5.75" />
    <path d="M4 12 12 4" />
  </I>
);

export const EmptySaveIcon = () => (
  <I>
    <path d="M4.5 2.5h7v11l-3.5-2.6-3.5 2.6Z" />
  </I>
);

/** The mock's `AT_IC`: a mention. */
export const AtIcon = () => (
  <I>
    <circle cx="8" cy="8" r="2.4" />
    <path d="M10.4 8v1a1.9 1.9 0 0 0 3.6.8A6 6 0 1 0 11 13" />
  </I>
);

/** The mock's `PERSON_IC`: an invite used. */
export const PersonIcon = () => (
  <I>
    <circle cx="8" cy="5.6" r="2.6" />
    <path d="M3 13.5c.5-2.6 2.6-4 5-4s4.5 1.4 5 4" />
  </I>
);

/** The mock's `EMPTY_BELL`: the empty notifications page. */
export const BellIcon = () => (
  <I>
    <path d="M4 11.5V7.25a4 4 0 0 1 8 0v4.25l1 1.25H3Z" />
    <path d="M6.6 14a1.5 1.5 0 0 0 2.8 0" />
  </I>
);
