// Text the feed prints, as the mock prints it (`rel`, `ktok`, `noun`,
// `clip`, `fmeta`, `fmtReply`, `plainReply`).

/** Relative time against `now` (`rel`): "now", "18m", "2h", "1d", "3w",
 * "2mo". */
export function relTime(iso: string, now: number): string {
  const minutes = (now - Date.parse(iso)) / 60_000;
  if (minutes < 1) return "now";
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.round(hours)}h`;
  const days = hours / 24;
  if (days < 7) return `${Math.round(days)}d`;
  if (days < 30) return `${Math.round(days / 7)}w`;
  return `${Math.round(days / 30)}mo`;
}

/** Tokens as the footer prints them (`ktok`): "41k tokens", or the exact
 * number below 1,000; "" for none. */
export function ktok(n: number): string {
  if (!n) return "";
  return `${n >= 1000 ? `${Math.round(n / 1000)}k` : n} tokens`;
}

export const noun = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** How an account that was deleted is named (04 §8, B6): the records it
 * left for other people's content carry `u: null`. */
export const DELETED_ACCOUNT = "Deleted account";

/** What stands in place of a frozen channel's owner (04 B6): the Browse
 * byline and the info dialog's "Channel by". */
export const CHANNEL_UNAVAILABLE = "Unavailable";

/** The name an author is shown by: the handle, or "Deleted account". */
export const authorName = (u: string | null): string => u ?? DELETED_ACCOUNT;

/** Clips at `n` characters on a word boundary with an ellipsis (`clip`). */
export function clip(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1).replace(/[\s,;:.]+\S*$/, "")}…`;
}

/** A card's footer meta (`fmeta`): "N sources · Nk tokens · #channel" for an
 * ask, "#channel" for a post (no sources or tokens),
 * empty parts left out. */
export function footerMeta(sources: number, tokens: number, channel: string | null): string {
  return [
    sources ? noun(sources, "source", "sources") : "",
    ktok(tokens),
    channel ? `#${channel}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Whether a thread's save count is drawn: never zero, and in a private
 * channel never below 3 (decision S6). */
export function showsSaveCount(count: number, privateChannel: boolean): boolean {
  return count > 0 && !(privateChannel && count < 3);
}

export const MENTION = /@([a-z0-9._]{2,20})/g;

/** A reply's text without its quoted lines, for its tree row (`plainReply`). */
export function plainReply(t: string): string {
  return (
    t
      .split("\n")
      .filter((line) => !line.startsWith(">"))
      .join(" ")
      .trim() || t
  );
}

export type ReplyPart =
  { kind: "quote"; lines: ReplyInline[][] } | { kind: "para"; inline: ReplyInline[] };
export type ReplyInline = { text: string; mention?: boolean };

/** A reply's text as blocks (`fmtReply`): lines starting with "> " are
 * quotes; `@handle` of a member is a mention. */
export function formatReply(t: string, isMember: (handle: string) => boolean): ReplyPart[] {
  const inlineOf = (line: string): ReplyInline[] => {
    const out: ReplyInline[] = [];
    let at = 0;
    for (const match of line.matchAll(MENTION)) {
      const handle = (match[1] ?? "").replace(/\.$/, "");
      if (!isMember(handle)) continue;
      const start = match.index;
      if (start > at) out.push({ text: line.slice(at, start) });
      out.push({ text: match[0], mention: true });
      at = start + match[0].length;
    }
    if (at < line.length) out.push({ text: line.slice(at) });
    return out;
  };
  const parts: ReplyPart[] = [];
  let quote: ReplyInline[][] = [];
  const flush = () => {
    if (quote.length) parts.push({ kind: "quote", lines: quote });
    quote = [];
  };
  for (const line of t.split("\n")) {
    const m = /^>\s?(.*)$/.exec(line);
    if (m) quote.push(inlineOf(m[1] ?? ""));
    else {
      flush();
      if (line.trim()) parts.push({ kind: "para", inline: inlineOf(line) });
    }
  }
  flush();
  return parts;
}
