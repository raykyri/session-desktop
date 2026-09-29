// The feed's journal cards (`10-home-feed-journal.md` §2, ported
// from `ResearchActivityFeed.tsx:208-312`).
//
// Link entries render in URL cards. Social posts render directly as tweet cards
// without generic content wrappers (`journal.css:1-5`).

import { safeHref } from "@session/shared";
import type { JournalEntry } from "@session/shared";
import { Copy, ExternalLink, LoaderCircle, MoreHorizontal, RotateCw, Trash2 } from "lucide-react";
import type { ReactNode } from "react";

import { useSignedIn } from "../../api/queries.js";
import { cn } from "../../lib/cn.js";
import { IconButton } from "../../ui/Button.js";
import { ContextMenu } from "../../ui/ContextMenu.js";
import { Menu, MenuSeparator } from "../../ui/Menu.js";
import { IconMenuItem } from "../sidebar/menuRows.js";

import { TweetEmbed } from "./TweetEmbed.js";
import { journalEntryMenuItems, journalEntryUrl, type JournalMenuAction } from "./entryMenu.js";

const EXTERNAL = { target: "_blank", rel: "noopener noreferrer" } as const;

function actionIcon(action: JournalMenuAction): ReactNode {
  switch (action) {
    case "open":
      return <ExternalLink size={13} aria-hidden="true" />;
    case "copy":
      return <Copy size={13} aria-hidden="true" />;
    case "retry":
      return <RotateCw size={13} aria-hidden="true" />;
    case "delete":
      return <Trash2 size={13} aria-hidden="true" />;
  }
}

export function JournalEntryMenuItems({
  entry,
  onAction,
}: {
  entry: JournalEntry;
  onAction: (action: JournalMenuAction) => void;
}) {
  const items = journalEntryMenuItems(entry);
  return (
    <>
      {items.map((item, index) => (
        <span key={item.action} className="contents">
          {item.danger && index > 0 ? <MenuSeparator /> : null}
          <IconMenuItem
            icon={actionIcon(item.action)}
            label={item.label}
            {...(item.danger ? { tone: "danger" as const } : {})}
            onClick={() => onAction(item.action)}
          />
        </span>
      ))}
    </>
  );
}

function EntryLink({ url }: { url: string }) {
  // The stored URL reaches an `href` here, and a restored entry's URL was never
  // re-validated by the server, so it renders as a link only if `safeHref`
  // accepts it and as plain text otherwise.
  const safe = safeHref(url);
  if (!safe) return <span className="text-fg-muted break-all">{url}</span>;
  return (
    <a
      href={safe}
      className="text-fg-link-external break-all underline-offset-2 hover:underline"
      {...EXTERNAL}
      onClick={(event) => event.stopPropagation()}
    >
      {url}
    </a>
  );
}

export function JournalEntryCard({
  entry,
  onAction,
}: {
  entry: JournalEntry;
  onAction?: (action: JournalMenuAction) => void;
}) {
  const signedIn = useSignedIn();
  const isTweetCard = entry.kind === "tweet" && entry.hydration === "ok" && entry.tweet;
  let body: ReactNode;
  if (entry.kind === "link") {
    body = <EntryLink url={entry.url} />;
  } else if (entry.hydration === "ok" && entry.tweet) {
    body = <TweetEmbed tweet={entry.tweet} />;
  } else if (entry.hydration === "failed") {
    body = (
      <div className="flex flex-col items-start gap-2">
        <EntryLink url={entry.url} />
        <p className="text-status-failed m-0 text-sm">
          Couldn’t load this post{entry.error ? ` — ${entry.error}` : ""}.
        </p>
        {signedIn && onAction ? (
          <button
            type="button"
            className="text-fg-interactive flex items-center gap-1 border-0 bg-transparent p-0 text-sm underline-offset-2 hover:underline"
            onClick={() => onAction("retry")}
          >
            <RotateCw size={12} aria-hidden="true" />
            <span>Retry</span>
          </button>
        ) : null}
      </div>
    );
  } else {
    body = (
      <div className="flex flex-col items-start gap-2">
        <EntryLink url={entry.url} />
        <p className="text-fg-muted m-0 flex items-center gap-1.5 text-sm">
          <LoaderCircle size={12} aria-hidden="true" className="session-spin" />
          <span>Loading post…</span>
        </p>
      </div>
    );
  }

  const article = (
    <article
      className={cn(
        "relative",
        isTweetCard
          ? // The tweet card is the entry rather than a tweet framed inside a
            // content item, but it keeps the entry's own padding
            // (`journal.css:290`): with none, the avatar and the age stamp sit
            // against the border.
            "journal-tweet-entry border-border-divider rounded-lg border px-3.5 py-3"
          : "bg-surface-card border-border-divider rounded-lg border px-3 py-2.5",
      )}
      title={new Date(entry.createdAt).toLocaleString()}
    >
      {body}
      {signedIn && onAction ? (
        <span className="absolute top-2 right-2">
          <Menu
            side="bottom"
            align="end"
            label="Saved entry actions"
            trigger={
              <IconButton label="Entry actions" className="bg-surface-panel/80">
                <MoreHorizontal size={13} aria-hidden="true" />
              </IconButton>
            }
          >
            <JournalEntryMenuItems entry={entry} onAction={onAction} />
          </Menu>
        </span>
      ) : null}
    </article>
  );

  if (!signedIn || !onAction) return article;
  return (
    <ContextMenu
      label="Saved entry actions"
      items={<JournalEntryMenuItems entry={entry} onAction={onAction} />}
    >
      {article}
    </ContextMenu>
  );
}

export { journalEntryMenuItems, journalEntryUrl };
