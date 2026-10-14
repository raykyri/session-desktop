// Column headers and the loading placeholder of a thread, ported from the
// desktop `ResearchColumnChrome.tsx`. A level's messages column header spans
// its answer column; note columns have their own Note and Follow-ups headers.
// Every header takes the height of the tallest (the strip measures them).

import { columnAttributes } from "@session/shared/lib/researchColumns";
import { Ellipsis, Terminal, X } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../../lib/cn.js";
import { useNavigationStore } from "../../stores/navigation.js";
import { HistoryNav } from "../../ui/HistoryNav.js";
import { SidebarRestoreButton } from "../../ui/SidebarRestoreButton.js";
import { FOCUS_RING } from "../../ui/surfaces.js";

import { BranchIcon } from "./icons.js";

/** Back and Forward in the root level's header: browser history, which
 * holds each column's selection. */
export interface ThreadHistoryNav {
  canGoBack: boolean;
  canGoForward: boolean;
  onBack: () => void;
  onForward: () => void;
}

const HEAD_BUTTON =
  "relative top-px inline-flex shrink-0 items-center gap-[3px] rounded-md border-0 bg-transparent px-2 py-[3px] " +
  "text-[length:calc(var(--fs-sm)-0.5px)] font-medium whitespace-nowrap text-fg-muted " +
  "hover:bg-surface-fill-hover hover:text-fg-primary " +
  FOCUS_RING;

/** The bar's left part: the sidebar's restore button while it is collapsed,
 * then Back and Forward. */
function HeaderLead({ history }: { history: ThreadHistoryNav | null }) {
  const collapsed = useNavigationStore((state) => state.sidebarCollapsed);
  const restore = useNavigationStore((state) => state.setSidebarCollapsed);
  if (!history) return null;
  return (
    <div className="-ml-2 flex shrink-0 items-center" role="group" aria-label="Research history">
      {collapsed ? <SidebarRestoreButton onRestore={() => restore(false)} /> : null}
      <HistoryNav
        canGoBack={history.canGoBack}
        canGoForward={history.canGoForward}
        onBack={history.onBack}
        onForward={history.onForward}
      />
    </div>
  );
}

export function PairHeader({
  title,
  branch = null,
  count = null,
  branchIcon = false,
  clear = null,
  history = null,
  imported = false,
  archived = false,
  menu = null,
  current = true,
  spanned = false,
  extra = null,
}: {
  title: string;
  /** A branch: its number of messages ("Branch · 2 messages"), or "new". */
  branch?: number | "new" | null;
  /** A count after the title ("Follow-ups · 3", "Branches · 2"). */
  count?: number | null;
  /** The branch icon before the title (a branches column's "Branches"). */
  branchIcon?: boolean;
  /** A × button that clears the column's selection. */
  clear?: { label: string; onClear: () => void } | null;
  history?: ThreadHistoryNav | null;
  /** A point-in-time copy of a terminal conversation. */
  imported?: boolean;
  archived?: boolean;
  /** A … button that opens the column's menu. */
  menu?: { label: string; open: boolean; onOpen: (trigger: HTMLButtonElement) => void } | null;
  /** The pair holds focus: its title is at full strength. */
  current?: boolean;
  /** A messages column's header, widened across its answer column. */
  spanned?: boolean;
  /** Shown before the … button: the root header's viewers (web only). */
  extra?: ReactNode;
}) {
  const smaller = branch !== null || count !== null;
  return (
    <header
      className={cn(
        "border-border-divider relative flex h-(--research-header-height,43px) shrink-0 items-center border-b",
        spanned &&
          "z-[1] w-[calc(var(--research-messages-width)+var(--research-answer-width)-2px)] bg-[var(--research-feed-bg)]",
      )}
    >
      <div
        className="flex min-h-[43px] min-w-0 flex-1 items-center gap-1.5 py-2 pr-2 pl-5"
        data-research-header-bar=""
      >
        <HeaderLead history={history} />
        <h2
          className={cn(
            "m-0 line-clamp-4 min-w-0 flex-1 overflow-hidden font-semibold [overflow-wrap:anywhere] focus:outline-none",
            smaller
              ? "text-[length:calc(14px+var(--font-ui-size-offset))]"
              : "text-[length:calc(15px+var(--font-ui-size-offset))]",
            current ? "text-fg-heading" : "text-fg-secondary",
          )}
          style={{ lineHeight: 1.35 }}
          tabIndex={-1}
          title={title}
        >
          {branch !== null ? (
            <>
              <BranchIcon size={13} className="text-fg-faint mr-[5px] inline align-[-1px]" />
              {branch === "new" ? "New branch" : "Branch"}
              {typeof branch === "number" && branch > 0 ? (
                <span className="text-fg-muted text-[length:calc(12.5px+var(--font-ui-size-offset))] font-normal">
                  {" "}
                  · {branch} {branch === 1 ? "message" : "messages"}
                </span>
              ) : null}
            </>
          ) : (
            <>
              {branchIcon ? (
                <BranchIcon size={13} className="text-fg-faint mr-[5px] inline align-[-1px]" />
              ) : null}
              {title}
              {count ? (
                <span className="text-fg-muted text-[length:calc(12.5px+var(--font-ui-size-offset))] font-normal">
                  {" "}
                  · {count}
                </span>
              ) : null}
            </>
          )}
        </h2>
        {imported ? (
          <span
            className="text-fg-muted inline-flex shrink-0 items-center gap-1 text-xs"
            title="This is a point-in-time copy of an imported conversation."
          >
            <Terminal size={12} aria-hidden="true" />
            Imported conversation
          </span>
        ) : null}
        {archived ? (
          <span className="border-border-default text-fg-muted shrink-0 rounded-full border px-[7px] py-px text-xs whitespace-nowrap">
            Archived
          </span>
        ) : null}
        {extra}
        {menu ? (
          <button
            type="button"
            className={HEAD_BUTTON}
            data-research-head-menu=""
            aria-label={menu.label}
            title={menu.label}
            aria-haspopup="menu"
            aria-expanded={menu.open}
            onClick={(event) => menu.onOpen(event.currentTarget)}
          >
            <Ellipsis size={15} aria-hidden="true" />
          </button>
        ) : null}
        {clear ? (
          <button
            type="button"
            className={HEAD_BUTTON}
            aria-label={clear.label}
            title={clear.label}
            onClick={clear.onClear}
          >
            <X size={14} aria-hidden="true" />
          </button>
        ) : null}
      </div>
    </header>
  );
}

/** The empty header above an answer column, under its messages column's
 * spanned header. */
export function SpannedHeaderSlot() {
  return (
    <header className="border-border-divider flex h-(--research-header-height,43px) shrink-0 border-b bg-[var(--research-feed-bg)]" />
  );
}

/** The loading or error state of a thread, with history controls and a
 * title, so they stay in place while the thread loads. */
export function ThreadPlaceholder({
  title = "",
  history = null,
  children,
}: {
  title?: string;
  history?: ThreadHistoryNav | null;
  children: ReactNode;
}) {
  return (
    <section
      className="border-border-strong relative flex h-full w-[calc(var(--research-messages-width)+var(--research-answer-width)-100px)] shrink-0 flex-col border-r border-l bg-[var(--research-thread-page-bg)]"
      {...columnAttributes({ id: "placeholder", role: "placeholder" })}
    >
      <PairHeader title={title} history={history} />
      {children}
    </section>
  );
}
