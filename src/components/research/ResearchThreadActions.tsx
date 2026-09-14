import { Bookmark } from "lucide-react";

/** Follow and Bookmark controls for one research thread. Both flags persist
 * on the tree, so Home cards and the open thread render the same pair from
 * the same state. */
export default function ResearchThreadActions({
  followed,
  bookmarked,
  onToggleFollow,
  onToggleBookmark,
}: {
  followed: boolean;
  bookmarked: boolean;
  onToggleFollow: () => void;
  onToggleBookmark: () => void;
}) {
  return (
    <div className="research-thread-actions">
      <button
        type="button"
        className={`control-button research-thread-action research-thread-follow${
          followed ? " is-active" : ""
        }`}
        aria-pressed={followed}
        title={followed ? "Stop following this thread" : "Follow this thread"}
        onClick={onToggleFollow}
      >
        {followed ? "Following" : "Follow"}
      </button>
      <button
        type="button"
        className={`control-button research-thread-action research-thread-bookmark${
          bookmarked ? " is-active" : ""
        }`}
        aria-pressed={bookmarked}
        aria-label={bookmarked ? "Remove bookmark" : "Bookmark"}
        title={bookmarked ? "Remove bookmark" : "Bookmark this thread"}
        onClick={onToggleBookmark}
      >
        <Bookmark
          size={13}
          aria-hidden="true"
          fill={bookmarked ? "currentColor" : "none"}
        />
      </button>
    </div>
  );
}
