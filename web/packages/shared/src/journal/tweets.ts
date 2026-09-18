// X posts: recognizing a permalink, finding the permalinks in a message, and
// normalizing X's syndication payload into the `TweetSnapshot` that is stored
// on a journal entry or a research message attachment.
//
// Ported from the desktop `src/lib/journalTweets.ts` (permalink parsing, the
// syndication token, and the snapshot normalizers) and `src-tauri/src/
// tweets.rs` (finding references in a message, the per-message cap, the
// inline/trailing placement rule, and the failure taxonomy). The desktop ran
// two normalizers — one in the renderer for journal entries, one in Rust for
// research attachments — and they drifted; there is one here, and both callers
// use it.
//
// The syndication response is an undocumented transport format, so it stays at
// the network boundary: the fetch belongs to the server, and the snapshot —
// not the raw payload — is the persisted format, so its shape changes
// deliberately.

import type { Nodes } from "mdast";
import remarkParse from "remark-parse";
import { unified } from "unified";

import type { ResearchMessageAttachment } from "../types/research.js";
import type {
  QuotedTweetSnapshot,
  TweetLinkCard,
  TweetMedia,
  TweetSnapshot,
  TweetTextRun,
} from "../types/tweet.js";

/** At most four posts are embedded per message; the rest of a link-heavy
 * message stays plain text. */
export const MAX_TWEETS_PER_MESSAGE = 4;
/** Caps on what a stored attachment may carry (`tweets.rs:18-19`). */
export const MAX_TWEET_SOURCE_URL_BYTES = 8 * 1024;
export const MAX_TWEET_SNAPSHOT_BYTES = 128 * 1024;
export const TWEET_ATTACHMENT_SCHEMA_VERSION = 1;

const TWEET_HOSTS = [
  "twitter.com",
  "www.twitter.com",
  "mobile.twitter.com",
  "x.com",
  "www.x.com",
  "mobile.x.com",
];

/** The status id from a tweet permalink, if `input` is one. Accepts
 * twitter.com / x.com (plus www. / mobile.) and both /status/ and the legacy
 * /statuses/, tolerating query strings, fragments, and trailing segments like
 * /photo/1. */
export function tweetIdFromUrl(input: string): string | null {
  const url = URL.parse(input);
  if (!url) {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return null;
  }
  if (!TWEET_HOSTS.includes(url.hostname.toLowerCase())) {
    return null;
  }
  const segments = url.pathname.split("/").filter(Boolean);
  const statusIndex = segments.findIndex(
    (segment) => segment === "status" || segment === "statuses",
  );
  // "x.com/status/…" (statusIndex 0) is not a tweet permalink — the handle
  // segment must precede /status/.
  if (statusIndex <= 0) {
    return null;
  }
  const id = segments[statusIndex + 1];
  return id && /^[0-9]+$/.test(id) ? id : null;
}

const encoder = new TextEncoder();

function byteLength(value: string): number {
  return encoder.encode(value).length;
}

/** An external URL a snapshot may carry: http(s), hosted, and small enough to
 * store. Anything else is dropped during normalization rather than persisted
 * and rendered. */
function validWebUrl(value: string): boolean {
  if (byteLength(value) > MAX_TWEET_SOURCE_URL_BYTES) {
    return false;
  }
  const url = URL.parse(value);
  return url !== null && (url.protocol === "https:" || url.protocol === "http:") && !!url.hostname;
}

/** The `token` query parameter the syndication CDN expects, derived the way
 * X's embedded-widget code derived it. The endpoint is loose about the value
 * today, but keeping it shaped like real widget output avoids depending on
 * that tolerance. */
export function syndicationToken(id: string): string {
  const token = ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");
  return token || "x";
}

type Payload = Record<string, unknown>;

const HTML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
};

function decodeEntities(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|#39|apos);/g, (match) => HTML_ENTITIES[match] ?? match);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function webUrl(value: unknown): string | undefined {
  const text = str(value);
  return text !== undefined && validWebUrl(text) ? text : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function record(value: unknown): Payload | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Payload)
    : undefined;
}

function records(value: unknown): Payload[] {
  return Array.isArray(value)
    ? value.filter((item): item is Payload => typeof item === "object" && item !== null)
    : [];
}

/** Expand a tweet's raw text into display runs: t.co URL entities become link
 * runs labeled by their display_url, t.co media links vanish (the media
 * renders separately), everything else stays plain text. */
function textRuns(raw: string, entities: unknown): TweetTextRun[] {
  const source = record(entities) ?? {};
  const subs: { tco: string; run: TweetTextRun | null }[] = [];
  for (const entity of records(source.urls)) {
    const tco = str(entity.url);
    const expanded = webUrl(entity.expanded_url);
    if (!tco || !expanded) {
      continue;
    }
    subs.push({
      tco,
      run: { kind: "link", text: str(entity.display_url) ?? expanded, url: expanded, tco },
    });
  }
  for (const media of records(source.media)) {
    const tco = str(media.url);
    if (tco) {
      subs.push({ tco, run: null });
    }
  }
  // Longer t.co strings first so a link is never split by a prefix match.
  subs.sort((left, right) => right.tco.length - left.tco.length);

  let runs: TweetTextRun[] = [{ kind: "text", text: decodeEntities(raw) }];
  for (const { tco, run } of subs) {
    const next: TweetTextRun[] = [];
    for (const existing of runs) {
      if (existing.kind !== "text" || !existing.text.includes(tco)) {
        next.push(existing);
        continue;
      }
      const parts = existing.text.split(tco);
      parts.forEach((part, index) => {
        if (part) {
          next.push({ kind: "text", text: part });
        }
        if (index < parts.length - 1 && run) {
          next.push({ ...run });
        }
      });
    }
    runs = next;
  }
  // Trim whitespace left hanging at the edges by removed media links.
  while (runs.length) {
    const last = runs[runs.length - 1];
    if (!last || last.kind !== "text") {
      break;
    }
    last.text = last.text.replace(/\s+$/, "");
    if (last.text) {
      break;
    }
    runs.pop();
  }
  while (runs.length) {
    const first = runs[0];
    if (!first || first.kind !== "text") {
      break;
    }
    first.text = first.text.replace(/^\s+/, "");
    if (first.text) {
      break;
    }
    runs.shift();
  }
  return runs;
}

/** At most four media items render on a card, the same limit X embeds use. */
const MAX_TWEET_MEDIA = 4;

function mediaItems(value: Payload): TweetMedia[] {
  const items: TweetMedia[] = [];
  for (const media of records(value.mediaDetails)) {
    if (items.length === MAX_TWEET_MEDIA) {
      break;
    }
    const imageUrl = webUrl(media.media_url_https);
    if (!imageUrl) {
      continue;
    }
    const type = str(media.type);
    if (type !== "photo" && type !== "video" && type !== "animated_gif") {
      continue;
    }
    const size = record(media.original_info) ?? {};
    const watchUrl = type === "photo" ? undefined : webUrl(media.expanded_url);
    const width = num(size.width);
    const height = num(size.height);
    const altText = str(media.ext_alt_text);
    const durationMillis = num(record(media.video_info)?.duration_millis);
    items.push({
      kind: type === "animated_gif" ? "gif" : type,
      imageUrl,
      ...(watchUrl !== undefined ? { watchUrl } : {}),
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
      ...(altText !== undefined ? { altText } : {}),
      ...(durationMillis !== undefined ? { durationMillis } : {}),
    });
  }
  return items;
}

/** The link preview a tweet carries, if any. Binding values are a flat bag of
 * typed entries; the image variants are many sizes of one picture, so this
 * takes the one that suits the card's layout. */
function linkCard(value: Payload, runs: TweetTextRun[]): TweetLinkCard | undefined {
  const card = record(value.card);
  const bindings = record(card?.binding_values);
  if (!card || !bindings) {
    return undefined;
  }
  const text = (key: string) => {
    const entry = record(bindings[key]);
    return entry?.type === "STRING" ? str(entry.string_value) : undefined;
  };
  const image = (key: string) => {
    const entry = record(bindings[key]);
    const value = entry?.type === "IMAGE" ? record(entry.image_value) : undefined;
    return value ? webUrl(value.url) : undefined;
  };
  const title = text("title");
  const domain = text("domain") ?? text("vanity_url");
  if (!title || !domain) {
    return undefined;
  }
  const large = str(card.name)?.includes("large_image") ?? false;
  // The card's own t.co, resolved through the text runs to the destination the
  // reader would actually visit.
  const cardUrl = text("card_url");
  const resolved = runs.find(
    (run) => run.kind === "link" && run.url && cardUrl && run.tco === cardUrl,
  );
  const url = resolved?.url ?? webUrl(card.url) ?? cardUrl;
  if (!url || !validWebUrl(url)) {
    return undefined;
  }
  const description = text("description");
  const imageUrl = large
    ? (image("photo_image_full_size_large") ?? image("summary_photo_image_large"))
    : (image("thumbnail_image") ?? image("thumbnail_image_small"));
  return {
    url,
    domain,
    title,
    ...(description !== undefined ? { description } : {}),
    ...(imageUrl !== undefined ? { imageUrl } : {}),
    large,
  };
}

/** At most ten edit ids are kept; an edit chain longer than that says nothing
 * more about the post. */
const MAX_TWEET_EDIT_IDS = 10;

function snapshotCore(fallbackId: string, value: Payload): QuotedTweetSnapshot | null {
  const user = record(value.user) ?? {};
  const handle = str(user.screen_name);
  if (!handle) {
    return null;
  }
  const id = str(value.id_str) ?? fallbackId;
  const partial = value.note_tweet !== undefined;
  const runs = textRuns(str(value.text) ?? "", value.entities);
  const card = linkCard(value, runs);
  // A link card stands for its URL, so the trailing t.co that produced it
  // drops out of the text — the way it does in a timeline.
  if (card) {
    const last = runs[runs.length - 1];
    if (last?.kind === "link" && last.url === card.url) {
      runs.pop();
      const tail = runs[runs.length - 1];
      if (tail?.kind === "text") {
        tail.text = tail.text.replace(/\s+$/, "");
        if (!tail.text) {
          runs.pop();
        }
      }
    }
  }
  // A preview is by definition cut off, so the text trails an ellipsis.
  if (partial && runs.length > 0) {
    const last = runs[runs.length - 1];
    if (last?.kind === "text" && !last.text.endsWith("…")) {
      last.text += "…";
    } else if (last && last.kind !== "text") {
      runs.push({ kind: "text", text: "…" });
    }
  }
  const avatarUrl = webUrl(user.profile_image_url_https);
  const createdAt = str(value.created_at);
  const replies = num(value.conversation_count);
  const likes = num(value.favorite_count);
  const possiblySensitive = bool(value.possibly_sensitive);
  const language = str(value.lang);
  const editControl = record(value.edit_control)?.edit_tweet_ids;
  const editIds = (Array.isArray(editControl) ? editControl : [])
    .filter((candidate): candidate is string => typeof candidate === "string")
    .slice(0, MAX_TWEET_EDIT_IDS);
  return {
    id,
    url: `https://x.com/${handle}/status/${id}`,
    author: {
      name: str(user.name) ?? "Unknown",
      handle,
      ...(avatarUrl !== undefined ? { avatarUrl } : {}),
      verified: user.is_blue_verified === true || user.verified === true,
    },
    ...(createdAt !== undefined ? { createdAt } : {}),
    runs,
    partial,
    media: mediaItems(value),
    ...(card ? { card } : {}),
    ...(replies !== undefined ? { replies } : {}),
    ...(likes !== undefined ? { likes } : {}),
    ...(possiblySensitive !== undefined ? { possiblySensitive } : {}),
    ...(language !== undefined ? { language } : {}),
    ...(editIds.length > 0 ? { editIds } : {}),
  };
}

/** The identity checks the desktop backend ran before storing a snapshot
 * (`validate_tweet_snapshot`): the id, its permalink, and the handle must
 * agree, so a hostile payload cannot point a stored card at another post. The
 * external URLs are already checked by `validWebUrl` during normalization, and
 * the structural checks are the zod schema's job at the trust boundary. */
function validSnapshotIdentity(snapshot: QuotedTweetSnapshot): boolean {
  return (
    /^[0-9]+$/.test(snapshot.id) &&
    /^[A-Za-z0-9_]{1,64}$/.test(snapshot.author.handle) &&
    tweetIdFromUrl(snapshot.url) === snapshot.id
  );
}

/** Normalize a raw syndication tweet-result payload into the stored snapshot.
 * Returns null for unavailable tweets (deleted, withheld, and protected come
 * back as TweetTombstone), unrecognized payloads, and anything that would not
 * be storable. */
export function tweetSnapshotFromSyndication(id: string, payload: unknown): TweetSnapshot | null {
  const value = record(payload);
  if (!value || value.__typename !== "Tweet") {
    return null;
  }
  const core = snapshotCore(id, value);
  if (!core) {
    return null;
  }
  const snapshot: TweetSnapshot = { ...core };
  const replyHandle = str(value.in_reply_to_screen_name);
  if (replyHandle) {
    const replyId = str(value.in_reply_to_status_id_str);
    snapshot.replyTo = { handle: replyHandle, ...(replyId !== undefined ? { id: replyId } : {}) };
  }
  const quotedPayload = record(value.quoted_tweet);
  if (quotedPayload) {
    // A tombstoned quote (deleted/withheld) is a stub with no user; the card
    // renders the tweet quote-less rather than failing hydration. Quote
    // snapshots are deliberately one level deep.
    const quoted = snapshotCore("", quotedPayload);
    if (quoted && quoted.id && validSnapshotIdentity(quoted)) {
      snapshot.quoted = quoted;
    }
  }
  if (!validSnapshotIdentity(snapshot)) {
    return null;
  }
  return byteLength(JSON.stringify(snapshot)) <= MAX_TWEET_SNAPSHOT_BYTES ? snapshot : null;
}

/** Where an embedded post sits in the message that referenced it. A trailing
 * permalink is presentation-only: the card replaces it, so the text does not
 * repeat the URL. An inline one keeps its place in the sentence. */
export type TweetAttachmentPlacement = ResearchMessageAttachment["placement"];

export type TweetAttachmentFailure = NonNullable<ResearchMessageAttachment["failure"]>;

export interface TweetReference {
  sourceUrl: string;
  tweetId: string;
  /** Offsets of the URL within the message; the placement rule reads them. */
  start: number;
  end: number;
  placement: TweetAttachmentPlacement;
}

const URL_PATTERN = /https?:\/\/[^\s<>]+/g;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}]+$/;

interface SourceRange {
  start: number;
  end: number;
}

/** Offsets of the code spans and fenced blocks in a message. A permalink
 * inside code is being shown, not shared, so it produces no attachment.
 *
 * The desktop backend took these ranges from pulldown-cmark; here they come
 * from the mdast the rest of the app already parses with. The URLs themselves
 * are still found by scanning the source text rather than by walking link
 * nodes, because placement depends on where the URL sits in what the user
 * typed: a permalink inside `[label](…)` is not trailing even at the end of
 * the message, since the closing parenthesis follows it. */
function markdownCodeRanges(message: string): SourceRange[] {
  const tree: Nodes = unified().use(remarkParse).parse(message);
  const ranges: SourceRange[] = [];
  const pending: Nodes[] = [tree];
  while (pending.length > 0) {
    const node = pending.pop();
    if (!node) {
      continue;
    }
    if (node.type === "code" || node.type === "inlineCode") {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined) {
        ranges.push({ start, end });
      }
      continue;
    }
    if ("children" in node) {
      pending.push(...node.children);
    }
  }
  return ranges;
}

/** The tweet permalinks in a message, in the order they appear, capped at
 * `MAX_TWEETS_PER_MESSAGE` and deduplicated by tweet id. */
export function tweetReferences(message: string): TweetReference[] {
  const codeRanges = markdownCodeRanges(message);
  const references: TweetReference[] = [];
  const seen = new Set<string>();
  for (const matched of message.matchAll(URL_PATTERN)) {
    const start = matched.index;
    if (codeRanges.some((range) => range.start <= start && start < range.end)) {
      continue;
    }
    // Sentence punctuation after a bare URL belongs to the sentence.
    const trimmed = matched[0].replace(TRAILING_PUNCTUATION, "");
    const tweetId = trimmed ? tweetIdFromUrl(trimmed) : null;
    if (!tweetId || byteLength(trimmed) > MAX_TWEET_SOURCE_URL_BYTES) {
      continue;
    }
    if (seen.has(tweetId)) {
      // One embed per tweet, but presentation follows the last authored
      // occurrence so a repeated permalink at the end can still hide.
      const existing = references.find((reference) => reference.tweetId === tweetId);
      if (existing) {
        existing.sourceUrl = trimmed;
        existing.start = start;
        existing.end = start + trimmed.length;
      }
      continue;
    }
    // Keep scanning after the cap so a later duplicate of an admitted tweet
    // can still determine presentation placement.
    if (references.length === MAX_TWEETS_PER_MESSAGE) {
      continue;
    }
    seen.add(tweetId);
    references.push({
      sourceUrl: trimmed,
      tweetId,
      start,
      end: start + trimmed.length,
      placement: "inline",
    });
  }

  // Every permalink in one whitespace-separated suffix is presentation-only.
  // Walk backwards because an earlier URL is trailing only after the later one
  // has also been recognized as part of that suffix.
  references.sort((left, right) => left.start - right.start);
  let cursor = message.trimEnd().length;
  for (let index = references.length - 1; index >= 0; index -= 1) {
    const reference = references[index];
    if (!reference || reference.end > cursor || message.slice(reference.end, cursor).trim()) {
      break;
    }
    reference.placement = "trailing";
    cursor = reference.start;
  }
  return references;
}

/** Classify a fetch error into the taxonomy stored on an attachment. */
export function classifyTweetFetchFailure(error: string): TweetAttachmentFailure {
  const lower = error.toLowerCase();
  if (lower.includes("timed out") || lower.includes("timeout")) {
    return "timeout";
  }
  if (lower.includes("404") || lower.includes("not found")) {
    return "notFound";
  }
  return "network";
}

/** What a fetch of the syndication endpoint came back with: the parsed body,
 * or the error text to classify. */
export type TweetFetchOutcome =
  { ok: true; payload: unknown; fetchedAt: number } | { ok: false; error: string };

/** The attachment recorded for one reference. A message keeps its own text
 * either way: an unavailable post leaves the permalink readable, and the
 * failure says whether retrying is worth it. */
export function tweetAttachmentFromFetch(
  reference: TweetReference,
  outcome: TweetFetchOutcome,
  attemptedAt: number,
): ResearchMessageAttachment {
  const base = {
    kind: "tweet",
    schemaVersion: TWEET_ATTACHMENT_SCHEMA_VERSION,
    sourceUrl: reference.sourceUrl,
    tweetId: reference.tweetId,
    placement: reference.placement,
    provider: "xSyndication",
    attemptedAt,
  } as const;
  if (outcome.ok) {
    const tweet = tweetSnapshotFromSyndication(reference.tweetId, outcome.payload);
    if (tweet) {
      return { ...base, status: "resolved", fetchedAt: outcome.fetchedAt, tweet };
    }
    return { ...base, status: "unavailable", failure: "invalidPayload" };
  }
  return { ...base, status: "unavailable", failure: classifyTweetFetchFailure(outcome.error) };
}
