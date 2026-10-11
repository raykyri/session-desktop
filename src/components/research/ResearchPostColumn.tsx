import type { ResearchNode, ResearchTreeDetail } from "../../types";
import { shortWhen } from "../../lib/shortTime";
import { ResearchUserMessage } from "./ResearchMessage";
import { PostContent } from "./ResearchPost";
import {
  nodeAttachments,
  nodeEditedAt,
  nodePrompt,
  postFollowUpSourceExcerpt,
} from "../../lib/researchNodeTypes";

/** A post's own column body: the post as a turn's question. Replies,
 * follow-ups and the follow-up composer are in the thread column to its
 * right (ResearchPostThread). The column header carries the history buttons. */
export default function ResearchPostColumn({
  detail,
  post,
  onSelectNode,
}: {
  detail: ResearchTreeDetail;
  post: ResearchNode;
  onSelectNode: (nodeId: string) => void;
}) {
  const parent = post.parentNodeId
    ? detail.nodes.find((node) => node.id === post.parentNodeId) ?? null
    : null;
  // A network follow-up's parent is always a post (the backend refuses any
  // other parent).
  const parentExcerpt = parent ? postFollowUpSourceExcerpt(parent, post, 60) : null;
  const editedAt = nodeEditedAt(post);

  return (
    <div className="post-column">
      {/* Use the turn layout for the post. */}
      <article className="research-turn post-turn">
        <div className="research-turn-question">
          {parent && parentExcerpt !== null ? (
            <button
              type="button"
              className="post-parent"
              onClick={() => onSelectNode(parent.id)}
            >
              ↳ Network follow-up of “{parentExcerpt}”
            </button>
          ) : null}
          <ResearchUserMessage className="research-prompt research-turn-prompt">
            <PostContent
              prompt={nodePrompt(post)}
              format={post.type === "post" ? post.format : "text"}
              attachments={nodeAttachments(post)}
            />
          </ResearchUserMessage>
          <div className="research-turn-meta">
            <time
              dateTime={new Date(post.createdAt).toISOString()}
              title={new Date(post.createdAt).toLocaleString()}
            >
              {shortWhen(post.createdAt, Date.now())}
            </time>
            {editedAt ? (
              <>
                <span aria-hidden="true">·</span>
                {/* The edit time is in the tooltip; the line reads "3h · Edited". */}
                <span title={`Edited ${new Date(editedAt).toLocaleString()}`}>Edited</span>
              </>
            ) : null}
          </div>
        </div>
      </article>
    </div>
  );
}
