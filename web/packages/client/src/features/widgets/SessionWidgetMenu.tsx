// The widget's "…" menu (the desktop's `SessionWidgetMenu.tsx`): export
// actions, the artifact's revisions, and the saved-input settings. Items that
// act close the menu first; toggling Remember inputs and retrying the history
// load keep it open.

import { Menu as BaseMenu } from "@base-ui/react/menu";
import type { ResearchArtifactRevision } from "@session/shared";
import type { ArtifactStateEntry } from "@session/shared/lib/sessionArtifactState";
import { Check, Copy, Download, Ellipsis, Expand, Import, RotateCcw } from "lucide-react";
import type { ReactElement, ReactNode } from "react";

import { cn } from "../../lib/cn.js";
import { Menu } from "../../ui/Menu.js";
import { MENU_ITEM, MENU_ITEM_SIZE, MENU_SEPARATOR } from "../../ui/surfaces.js";

import { changeArtifactState } from "./artifactState.js";
import type { ArtifactHistory } from "./useWidgetRevision.js";

/** A revision's relation to its parent, as the history rows show it. */
export function lineageLabel(entry: ResearchArtifactRevision): string {
  if (entry.unresolvedParent) return "original (declared parent not found)";
  return entry.parentRevision ? `from ${entry.parentRevision.slice(0, 8)}` : "original";
}

const ITEM = cn(
  MENU_ITEM,
  MENU_ITEM_SIZE.sm,
  "data-disabled:cursor-default data-disabled:opacity-50",
);

/** The menu's 16px leading column: an icon, a check mark, or nothing. */
function Lead({ children }: { children?: ReactNode }) {
  return (
    <span
      className="text-fg-muted inline-flex w-4 shrink-0 items-center justify-center"
      aria-hidden="true"
    >
      {children}
    </span>
  );
}

function Item({
  icon,
  children,
  onClick,
  disabled,
  closeOnClick = true,
  title,
  trailing,
  current,
}: {
  icon: ReactElement | null;
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  closeOnClick?: boolean;
  title?: string;
  trailing?: ReactNode;
  current?: boolean;
}) {
  return (
    <BaseMenu.Item
      className={ITEM}
      disabled={disabled ?? false}
      closeOnClick={closeOnClick}
      onClick={onClick}
      {...(title === undefined ? {} : { title })}
      {...(current ? { "aria-current": "true" as const } : {})}
    >
      <Lead>{icon}</Lead>
      <span className="min-w-0 truncate">{children}</span>
      {trailing === undefined ? null : (
        <span className="text-fg-faint ml-auto min-w-0 truncate pl-3 text-xs">{trailing}</span>
      )}
    </BaseMenu.Item>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <BaseMenu.Group>
      <BaseMenu.GroupLabel className="text-fg-faint px-2 pt-1.5 pb-0.5 text-xs">
        {label}
      </BaseMenu.GroupLabel>
      {children}
    </BaseMenu.Group>
  );
}

function Note({ children }: { children: ReactNode }) {
  return (
    <div className="text-fg-faint py-1 pr-2 pl-8 text-sm" role="presentation">
      {children}
    </div>
  );
}

export function SessionWidgetMenu({
  open,
  onOpenChange,
  revision,
  hasScripts,
  stateEntry,
  history,
  onLoadHistory,
  onCopy,
  onDownload,
  onOpenExpanded,
  onPreviewRevision,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  revision: ResearchArtifactRevision | null;
  hasScripts: boolean;
  stateEntry: ArtifactStateEntry;
  history: ArtifactHistory;
  onLoadHistory: () => void;
  onCopy: () => void;
  onDownload: () => void;
  /** Absent when the widget has no page to open. */
  onOpenExpanded: (() => void) | null;
  onPreviewRevision: (entry: ResearchArtifactRevision) => void;
}) {
  const remembered = stateEntry.config?.enabled ?? false;
  const parent =
    revision?.parentRevision && !revision.unresolvedParent ? revision.parentRevision : null;
  return (
    <Menu
      open={open}
      onOpenChange={onOpenChange}
      align="end"
      size="sm"
      label="Widget actions"
      className="max-w-[340px]"
      trigger={
        <button
          type="button"
          className="session-widget-action"
          title="Widget actions"
          aria-label="Widget actions"
        >
          <Ellipsis aria-hidden="true" />
        </button>
      }
    >
      <Item icon={<Copy size={14} />} onClick={onCopy}>
        Copy HTML
      </Item>
      <Item icon={<Download size={14} />} onClick={onDownload}>
        Download HTML
      </Item>
      {onOpenExpanded ? (
        <Item icon={<Expand size={14} />} onClick={onOpenExpanded}>
          Open expanded view
        </Item>
      ) : null}
      {revision ? (
        <>
          <BaseMenu.Separator className={MENU_SEPARATOR} />
          <Section label="Revisions">
            {history.status === "idle" || history.status === "loading" ? (
              <Note>Loading revisions…</Note>
            ) : null}
            {history.status === "error" ? (
              <>
                <Note>{history.message}</Note>
                <Item icon={<RotateCcw size={14} />} closeOnClick={false} onClick={onLoadHistory}>
                  Try again
                </Item>
              </>
            ) : null}
            {history.status === "ready" ? (
              <>
                {history.revisions.map((entry) => {
                  const current = entry.revision === revision.revision;
                  return (
                    <Item
                      key={`${entry.nodeId}:${entry.revision}`}
                      icon={current ? <Check size={14} /> : null}
                      current={current}
                      trailing={lineageLabel(entry)}
                      title={`Preview revision ${entry.revision.slice(0, 8)} from answer ${entry.nodeId.slice(0, 8)}`}
                      onClick={() => onPreviewRevision(entry)}
                    >
                      <span className="font-mono text-sm">{entry.revision.slice(0, 8)}</span>
                    </Item>
                  );
                })}
                {history.unresolved > 0 ? (
                  <Note>{`${history.unresolved} source revision(s) could not be stored. Their source exceeds the size limit or could not be saved.`}</Note>
                ) : null}
              </>
            ) : null}
          </Section>
          {hasScripts ? (
            <>
              <BaseMenu.Separator className={MENU_SEPARATOR} />
              <Section label="Saved inputs">
                <BaseMenu.CheckboxItem
                  className={ITEM}
                  checked={remembered}
                  // Disabled until the setting loads. While a change is in
                  // flight the item ignores selection, so keyboard focus
                  // stays in the open menu.
                  disabled={!stateEntry.config}
                  closeOnClick={false}
                  onCheckedChange={() => {
                    if (stateEntry.pending > 0) return;
                    void changeArtifactState(revision, remembered ? "disable" : "enable");
                  }}
                >
                  <Lead>{remembered ? <Check size={14} /> : null}</Lead>
                  <span className="min-w-0 truncate">Remember inputs</span>
                </BaseMenu.CheckboxItem>
                {remembered ? (
                  <>
                    <Item
                      icon={<RotateCcw size={14} />}
                      disabled={stateEntry.pending > 0}
                      onClick={() => void changeArtifactState(revision, "reset")}
                    >
                      Reset inputs
                    </Item>
                    {parent ? (
                      <Item
                        icon={<Import size={14} />}
                        disabled={stateEntry.pending > 0}
                        title="Replace this revision's saved inputs with the parent's JSON state. Use this only if both revisions use the same input format."
                        onClick={() => void changeArtifactState(revision, "migrate")}
                      >
                        {`Copy inputs from ${parent.slice(0, 8)}`}
                      </Item>
                    ) : null}
                  </>
                ) : null}
              </Section>
            </>
          ) : null}
        </>
      ) : null}
    </Menu>
  );
}
