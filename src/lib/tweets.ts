// Tweet snapshots as the backend resolves them into research message
// attachments (src-tauri/src/tweets.rs). Rendering lives in TweetEmbed.

interface TweetMedia {
  kind: "photo" | "video" | "gif";
  /** Direct https image URL: the photo itself, or the video poster frame. */
  imageUrl: string;
  /** Permalink for watching the video on X (videos and gifs only). */
  watchUrl?: string;
  width?: number;
  height?: number;
  altText?: string;
  durationMillis?: number;
}

/** One span of the tweet text: plain text, or a t.co entity expanded into a
 * link labeled with its display form. Structured runs rather than markdown so
 * tweet text that happens to contain markdown syntax renders literally. */
export interface TweetTextRun {
  kind: "text" | "link";
  text: string;
  /** Expanded destination, for link runs. */
  url?: string;
  /** The t.co this run replaced, so a link card can find the run it stands
   * for. Kept off the wire when absent. */
  tco?: string;
}

/** A link preview the tweet carries — the bordered card X renders under the
 * text for a shared URL. `large` is the wide-image variant. */
interface TweetLinkCard {
  url: string;
  domain: string;
  title: string;
  description?: string;
  imageUrl?: string;
  large: boolean;
}

/** The resolved form of a tweet: everything the embed renders, and nothing
 * tied to the syndication payload's shape. */
export interface TweetSnapshot {
  id: string;
  url: string;
  author: {
    name: string;
    handle: string;
    avatarUrl?: string;
    /** Carries a verification badge (blue or legacy). */
    verified?: boolean;
  };
  /** ISO timestamp of the tweet itself (not the capture). */
  createdAt?: string;
  runs: TweetTextRun[];
  /** True when the payload is a preview of a longer post (full text is not
   * available from the syndication endpoint). */
  partial: boolean;
  media: TweetMedia[];
  card?: TweetLinkCard;
  /** Engagement counts as captured. Absent when the payload omits them. */
  replies?: number;
  likes?: number;
  replyTo?: { handle: string; id?: string };
  quoted?: QuotedTweetSnapshot;
  possiblySensitive?: boolean;
  language?: string;
  editIds?: string[];
}

export type QuotedTweetSnapshot = Omit<TweetSnapshot, "quoted" | "replyTo">;
