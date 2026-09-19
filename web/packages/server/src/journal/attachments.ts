// The posts a research question links to (`04-agent-runtime.md` §5,
// `tweets.rs:744-757`).
//
// A question that names an X permalink is asking about that post, so the post
// is resolved once — at launch, before the node exists — and the snapshot is
// stored on the node. Everything downstream then reads one durable record:
// the card renders the snapshot (`SegmentPrompt.tsx`), and the launch prompt
// carries its text to the model as untrusted reference material
// (`promptWithResearchAttachments`). Nothing re-fetches while reading, and a
// post deleted a month later still shows the way it did when it was asked
// about.
//
// Resolution is on the launch path, so it is bounded: at most
// `MAX_TWEETS_PER_MESSAGE` posts, fetched in parallel, and the whole step
// abandoned after `ATTACHMENT_RESOLUTION_BUDGET_MS`. A post that does not
// answer in time is recorded `unavailable` with a `timeout`, which leaves its
// permalink readable in the question instead of holding up the run.

import type { ResearchMessageAttachment } from "@session/shared";
import { tweetAttachment, tweetReferences } from "@session/shared";

import type { TweetHydrationDeps } from "./tweets.js";
import { resolveTweet } from "./tweets.js";

/**
 * How long a launch waits for the posts its question links to. Past it the
 * question is launched with what resolved; the cache makes a repeat of the
 * same permalink immediate, so this is a first-sighting cost.
 */
export const ATTACHMENT_RESOLUTION_BUDGET_MS = 9_000;

/** The handle in a permalink, for the oEmbed fallback's URL. The value is
 * re-checked there; this only avoids handing it an obviously wrong segment. */
function handleOf(sourceUrl: string): string | undefined {
  const segment = URL.parse(sourceUrl)?.pathname.split("/").filter(Boolean)[0];
  return segment === undefined || segment === "" ? undefined : segment;
}

/**
 * The attachments for one research message, in the order the permalinks appear
 * in it. An empty list is the common case and costs nothing: a message with no
 * permalink never reaches a fetch.
 */
export async function resolveMessageAttachments(
  deps: TweetHydrationDeps,
  prompt: string,
  budgetMs: number = ATTACHMENT_RESOLUTION_BUDGET_MS,
): Promise<ResearchMessageAttachment[]> {
  const references = tweetReferences(prompt);
  if (references.length === 0) {
    return [];
  }
  const attemptedAt = Date.now();
  const deadline = new Promise<"timeout">((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), budgetMs);
    // A launch must not be held open by this timer once every fetch has
    // answered, and the process must not be either.
    timer.unref?.();
  });
  return Promise.all(
    references.map(async (reference) => {
      // The resolution outlives the deadline it lost to: it keeps going and
      // writes what it finds to `tweet_cache`, so the same permalink asked
      // again resolves immediately. Its rejection is caught here rather than
      // left to surface after the launch has already answered.
      const resolution = resolveTweet(deps, reference.tweetId, {
        handle: handleOf(reference.sourceUrl),
      }).catch((error: unknown) => {
        deps.logger?.warn({ tweetId: reference.tweetId, error }, "could not resolve a post");
        return null;
      });
      const resolved = await Promise.race([resolution, deadline]);
      if (resolved === "timeout" || resolved === null) {
        return tweetAttachment(
          reference,
          { status: "unavailable", failure: resolved === null ? "network" : "timeout" },
          attemptedAt,
        );
      }
      if (resolved.status === "resolved" && resolved.snapshot && resolved.provider) {
        return tweetAttachment(
          reference,
          {
            status: "resolved",
            provider: resolved.provider,
            tweet: resolved.snapshot,
            fetchedAt: resolved.fetchedAt,
          },
          attemptedAt,
        );
      }
      return tweetAttachment(
        reference,
        { status: "unavailable", failure: resolved.failureKind ?? "network" },
        attemptedAt,
      );
    }),
  );
}
