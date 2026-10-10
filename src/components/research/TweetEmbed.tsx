import { createContext, useContext, useState } from "react";
import type { MouseEvent, ReactNode } from "react";
import { Play } from "lucide-react";
import { openExternalUrl } from "../../lib/api";
import type {
  QuotedTweetSnapshot,
  TweetSnapshot,
  TweetTextRun,
} from "../../lib/tweets";

function externalLinkClick(url: string) {
  return (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    void openExternalUrl(url);
  };
}

/** Whether the embed's parts open on X. Off in Home, where a click on a
 * tweet belongs to its feed row. */
const TweetLinksOpen = createContext(true);

/** A link to X, or, where the embed does not open links, the same content in
 * a span so a click falls through to what holds the embed. */
function TweetLink({
  url,
  className,
  title,
  hidden,
  children,
}: {
  url: string | undefined;
  className?: string;
  title?: string;
  /** For a link that repeats a neighbouring one (the avatar's). */
  hidden?: boolean;
  children: ReactNode;
}) {
  const open = useContext(TweetLinksOpen);
  if (!open || !url) {
    return (
      <span className={className} title={title} aria-hidden={hidden || undefined}>
        {children}
      </span>
    );
  }
  return (
    <a
      className={className}
      href={url}
      title={title}
      aria-hidden={hidden || undefined}
      tabIndex={hidden ? -1 : undefined}
      onClick={externalLinkClick(url)}
    >
      {children}
    </a>
  );
}

// No avatar (older snapshots, fetch-blocked images fall back via onError is
// out of scope) renders an initial on a disc whose hue derives from the
// handle — stable across renders and distinct between authors.
function avatarFallback(name: string, handle: string) {
  const seed = handle || name;
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return {
    initial: [...(name || seed)][0]?.toUpperCase() ?? "?",
    color: `hsl(${hash % 360} 55% 45%)`,
  };
}

function TweetAvatar({
  name,
  handle,
  avatarUrl,
  size,
}: {
  name: string;
  handle: string;
  avatarUrl?: string;
  size: number;
}) {
  // A snapshot's avatar URL can go stale (profile changed, image deleted);
  // a failed load falls back to the initial disc instead of a broken image.
  const [failed, setFailed] = useState(false);
  if (avatarUrl && !failed) {
    return (
      <img
        className="journal-tweet-avatar"
        src={avatarUrl}
        width={size}
        height={size}
        style={{ width: size, height: size }}
        alt=""
        aria-hidden="true"
        draggable={false}
        onError={() => setFailed(true)}
      />
    );
  }
  const fallback = avatarFallback(name, handle);
  return (
    <span
      className="journal-tweet-avatar journal-tweet-avatar-fallback"
      style={{ width: size, height: size, background: fallback.color }}
      aria-hidden="true"
    >
      {fallback.initial}
    </span>
  );
}

function TweetText({ runs, className, compact }: {
  runs: TweetTextRun[];
  className: string;
  compact?: boolean;
}) {
  if (runs.length === 0) {
    return null;
  }
  return (
    <p className={className}>
      {runs.map((run, index) => {
        // Feed previews keep single line breaks (including lists), but omit
        // blank lines without changing the saved tweet or its link targets.
        const text = compact ? run.text.replace(/\r?\n(?:[\t ]*\r?\n)+/g, "\n") : run.text;
        return run.kind === "link" && run.url ? (
          <TweetLink key={index} url={run.url} className="journal-tweet-link">
            {text}
          </TweetLink>
        ) : (
          <span key={index}>{text}</span>
        );
      })}
    </p>
  );
}

function TweetMediaStrip({
  media,
  compact,
  sensitive,
}: {
  media: QuotedTweetSnapshot["media"];
  compact?: boolean;
  sensitive?: boolean;
}) {
  const [revealed, setRevealed] = useState(!sensitive);
  if (media.length === 0) {
    return null;
  }
  return (
    <div
      className={`journal-tweet-media${media.length > 1 ? " is-multi" : ""}${
        compact ? " is-compact" : ""
      }${sensitive && !revealed ? " is-sensitive" : ""}`}
    >
      {media.map((item, index) => {
        // Known dimensions reserve the media box before (or without) the
        // image, so the feed doesn't reflow as media arrives.
        const aspect =
          item.width && item.height
            ? { aspectRatio: `${item.width} / ${item.height}` }
            : undefined;
        const image = (
          <img
            src={item.imageUrl}
            alt={
              item.altText ?? (item.kind === "photo" ? "Photo" : "Video thumbnail")
            }
            loading="lazy"
            draggable={false}
            style={aspect}
          />
        );
        if (item.kind === "photo") {
          return (
            <span key={index} className="journal-tweet-media-item">
              {image}
            </span>
          );
        }
        const watchUrl = item.watchUrl;
        return (
          <TweetLink
            key={index}
            url={watchUrl}
            className="journal-tweet-media-item journal-tweet-video"
            title={item.kind === "gif" ? "Watch GIF on X" : "Watch video on X"}
          >
            {image}
            <span className="journal-tweet-play" aria-hidden="true">
              <Play size={compact ? 14 : 18} fill="currentColor" />
            </span>
          </TweetLink>
        );
      })}
      {sensitive && !revealed ? (
        <button
          type="button"
          className="journal-tweet-sensitive-reveal"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setRevealed(true);
          }}
        >
          Show sensitive media
        </button>
      ) : null}
    </div>
  );
}

/** The age stamp: "29m" and "5h" inside a day, "Jul 27" inside the year, and
 * the short numeric date ("3/21/06") beyond it, so the stamp leaves the header
 * line to the display name. */
function formatTweetAge(iso: string | undefined, now = Date.now()): string | null {
  if (!iso) {
    return null;
  }
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  const seconds = Math.max(0, Math.round((now - parsed.getTime()) / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m`;
  }
  if (seconds < 86_400) {
    return `${Math.floor(seconds / 3600)}h`;
  }
  const sameYear = parsed.getFullYear() === new Date(now).getFullYear();
  return parsed.toLocaleDateString(
    undefined,
    sameYear ? { month: "short", day: "numeric" } : { month: "numeric", day: "numeric", year: "2-digit" },
  );
}

/** The full stamp behind the age, for the title tooltip. */
function formatTweetDate(iso: string | undefined): string | null {
  if (!iso) {
    return null;
  }
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toLocaleString();
}

/** Engagement counts the way a timeline abbreviates them: exact under ten
 * thousand, whole thousands past it, one decimal past a million. */
function formatTweetCount(value: number): string {
  if (value < 10_000) {
    return value.toLocaleString();
  }
  if (value < 1_000_000) {
    return `${Math.floor(value / 1000)}K`;
  }
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

function ReplyGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    </svg>
  );
}

function LikeGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
    </svg>
  );
}

function VerifiedBadge() {
  return (
    <svg
      className="journal-tweet-verified"
      viewBox="0 0 22 22"
      fill="currentColor"
      aria-label="Verified"
      role="img"
    >
      <path d="M20.396 11c-.018-.646-.215-1.275-.57-1.816-.354-.54-.852-.972-1.438-1.246.223-.607.27-1.264.14-1.897-.131-.634-.437-1.218-.882-1.687-.47-.445-1.053-.75-1.687-.882-.633-.13-1.29-.083-1.897.14-.273-.587-.704-1.086-1.245-1.44S11.647 1.62 11 1.604c-.646.017-1.273.213-1.813.568s-.969.854-1.24 1.44c-.608-.223-1.267-.272-1.902-.14-.635.13-1.22.436-1.69.882-.445.47-.749 1.055-.878 1.688-.13.633-.08 1.29.144 1.896-.587.274-1.087.705-1.443 1.245-.356.54-.555 1.17-.574 1.817.02.647.218 1.276.574 1.816.356.54.856.972 1.443 1.245-.224.606-.274 1.263-.144 1.896.13.634.433 1.218.877 1.688.47.443 1.054.747 1.687.878.633.132 1.29.084 1.897-.136.274.586.705 1.084 1.246 1.439.54.354 1.17.551 1.816.569.647-.016 1.276-.213 1.817-.567s.972-.854 1.245-1.44c.604.239 1.266.296 1.903.164.636-.132 1.22-.447 1.68-.907.46-.46.776-1.044.908-1.681s.075-1.299-.165-1.903c.586-.274 1.084-.705 1.439-1.246.354-.54.551-1.17.569-1.816zM9.662 14.85l-3.429-3.428 1.293-1.302 2.072 2.072 4.4-4.794 1.347 1.246z" />
    </svg>
  );
}

function TweetLinkCardView({ card }: { card: NonNullable<TweetSnapshot["card"]> }) {
  return (
    <TweetLink url={card.url} className={`journal-tweet-card${card.large ? " is-large" : ""}`}>
      {card.imageUrl ? (
        <span className="journal-tweet-card-media">
          <img src={card.imageUrl} alt="" loading="lazy" draggable={false} />
        </span>
      ) : null}
      <span className="journal-tweet-card-copy">
        <span className="journal-tweet-card-domain">{card.domain}</span>
        <span className="journal-tweet-card-title">{card.title}</span>
        {card.description ? (
          <span className="journal-tweet-card-desc">{card.description}</span>
        ) : null}
      </span>
    </TweetLink>
  );
}

/** Renders a hydrated tweet directly as a feed entry. The compact layout
 * uses a single header row with a 20px avatar, name, and badge. The handle is
 * available in the name's tooltip and accessible label. Full-width text with
 * Show more under it, media, and the quote follow; the timestamp and
 * engagement counts share the footer. With `openable` off (Home), no part of
 * the embed opens X, so a click reaches the feed row, and cut-off text ends at
 * its ellipsis without Show more. Exported for static-markup tests. */
export function TweetEmbed({
  tweet,
  compact = false,
  openable = true,
}: {
  tweet: TweetSnapshot;
  compact?: boolean;
  openable?: boolean;
}) {
  return (
    <TweetLinksOpen.Provider value={openable}>
      <TweetEmbedBody tweet={tweet} compact={compact} />
    </TweetLinksOpen.Provider>
  );
}

function TweetEmbedBody({ tweet, compact }: { tweet: TweetSnapshot; compact: boolean }) {
  const openable = useContext(TweetLinksOpen);
  const quoted = tweet.quoted;
  const authorUrl = `https://x.com/${tweet.author.handle}`;
  const age = formatTweetAge(tweet.createdAt);
  const hasStats = tweet.replies !== undefined || tweet.likes !== undefined;
  return (
    <article
      className={`journal-tweet${compact ? " is-compact" : ""}${openable ? "" : " is-static"}`}
      aria-label={`${openable ? "Open tweet" : "Tweet"} by @${tweet.author.handle}`}
      role={openable ? "link" : undefined}
      tabIndex={openable ? 0 : undefined}
      onClick={
        openable
          ? (event) => {
              // Descendant links and controls prevent their handled click from
              // reaching here. Everything else on the embed opens this tweet.
              if (event.defaultPrevented) {
                return;
              }
              event.preventDefault();
              event.stopPropagation();
              void openExternalUrl(tweet.url);
            }
          : undefined
      }
      onKeyDown={
        openable
          ? (event) => {
              if (event.target !== event.currentTarget || event.key !== "Enter") {
                return;
              }
              event.preventDefault();
              event.stopPropagation();
              void openExternalUrl(tweet.url);
            }
          : undefined
      }
    >
      <div className="journal-tweet-main">
        <div className="journal-tweet-head">
          <TweetLink url={authorUrl} className="journal-tweet-avatar-link" hidden>
            <TweetAvatar
              name={tweet.author.name}
              handle={tweet.author.handle}
              avatarUrl={tweet.author.avatarUrl}
              size={20}
            />
          </TweetLink>
          <div className="journal-tweet-who">
            <TweetLink
              url={authorUrl}
              className="journal-tweet-author"
              title={`${tweet.author.name} @${tweet.author.handle}`}
            >
              {tweet.author.name}
            </TweetLink>
            {tweet.author.verified ? <VerifiedBadge /> : null}
            <span className="journal-tweet-handle">@{tweet.author.handle}</span>
          </div>
        </div>
        {tweet.replyTo ? (
          <p className="journal-tweet-reply">
            Replying to <span>@{tweet.replyTo.handle}</span>
          </p>
        ) : null}
        <TweetText runs={tweet.runs} className="journal-tweet-text" compact={compact} />
        {tweet.partial && openable ? (
          <TweetLink url={tweet.url} className="journal-tweet-more">
            Show more
          </TweetLink>
        ) : null}
        <TweetMediaStrip media={tweet.media} sensitive={tweet.possiblySensitive} />
        {tweet.card ? <TweetLinkCardView card={tweet.card} /> : null}
        {quoted ? (
          <div
            className="journal-tweet-quote"
            role={openable ? "link" : undefined}
            tabIndex={openable ? 0 : undefined}
            onClick={
              openable
                ? (event) => {
                    event.stopPropagation();
                    // Links inside the quoted text keep their own targets.
                    if ((event.target as HTMLElement).closest("a")) {
                      return;
                    }
                    void openExternalUrl(quoted.url);
                  }
                : undefined
            }
            onKeyDown={
              openable
                ? (event) => {
                    if (event.target === event.currentTarget && event.key === "Enter") {
                      event.preventDefault();
                      event.stopPropagation();
                      void openExternalUrl(quoted.url);
                    }
                  }
                : undefined
            }
          >
            <div className="journal-tweet-quote-head">
              <TweetAvatar
                name={quoted.author.name}
                handle={quoted.author.handle}
                avatarUrl={quoted.author.avatarUrl}
                size={18}
              />
              <TweetLink url={`https://x.com/${quoted.author.handle}`} className="journal-tweet-author">
                {quoted.author.name}
              </TweetLink>
              {quoted.author.verified ? <VerifiedBadge /> : null}
              <span className="journal-tweet-handle">@{quoted.author.handle}</span>
            </div>
            <TweetText runs={quoted.runs} className="journal-tweet-text is-quote" compact={compact} />
            {quoted.partial ? (
              <span className="journal-tweet-more">Show more</span>
            ) : null}
            <TweetMediaStrip
              media={quoted.media}
              compact
              sensitive={quoted.possiblySensitive}
            />
            {quoted.card ? <TweetLinkCardView card={quoted.card} /> : null}
          </div>
        ) : null}
        {age || hasStats ? (
          <div className="journal-tweet-end">
            {age ? (
              <time
                className="journal-tweet-age"
                dateTime={tweet.createdAt}
                title={formatTweetDate(tweet.createdAt) ?? undefined}
              >
                {age}
              </time>
            ) : null}
            {hasStats ? (
              // Display the saved engagement counts as static metadata.
              <div className="journal-tweet-stats">
                {tweet.replies !== undefined ? (
                  <span className="journal-tweet-stat" title={`${tweet.replies} replies`}>
                    <ReplyGlyph />
                    {formatTweetCount(tweet.replies)}
                  </span>
                ) : null}
                {tweet.likes !== undefined ? (
                  <span className="journal-tweet-stat" title={`${tweet.likes} likes`}>
                    <LikeGlyph />
                    {formatTweetCount(tweet.likes)}
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </article>
  );
}
