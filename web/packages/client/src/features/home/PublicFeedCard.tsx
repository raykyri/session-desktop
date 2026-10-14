// A card of the All Users and My Workspaces feeds: Home's card for a thread's
// root entry, without the drag handle and menu.

import type { RecentResearchQuery } from "@session/shared";
import { researchCardTitle } from "@session/shared/lib/researchFolders";
import { nodeType } from "@session/shared/lib/researchNodeTypes";
import { researchRowKind, researchRowState } from "@session/shared/lib/researchRowGlyph";

import { CardBody } from "./CardBody.js";
import { FeedCard } from "./FeedCard.js";

export function PublicFeedCard({
  query,
  onOpen,
}: {
  query: RecentResearchQuery;
  onOpen: () => void;
}) {
  const isPost = nodeType(query) === "post";
  const title = isPost ? null : researchCardTitle(query.title, query.prompt);
  const awaitingTitle = !isPost && !query.title?.trim();
  return (
    <FeedCard
      cardId={query.treeId}
      place=""
      title={title}
      label={title ? `${title}. ${query.prompt}` : query.prompt}
      body={
        <CardBody
          query={query}
          fallback={query.prompt}
          isPost={isPost}
          awaitingTitle={awaitingTitle}
          underTitle={Boolean(title)}
        />
      }
      kind={researchRowKind(query)}
      state={researchRowState(query.status)}
      onOpen={onOpen}
    />
  );
}
