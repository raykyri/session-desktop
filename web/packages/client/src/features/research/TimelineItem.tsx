// One message of a rendered answer (`09-research-document-view.md` §7).
//
// Memoized on the item, which is keyed by its originating turn id: the tree
// detail is replaced by every research event, and without the memo each
// replacement would re-parse the Markdown of every visible item. The desktop
// needed a per-node view cache to make that memo hold; here the item identities
// come from the query cache's `Turn[]`, which only changes when the node's own
// content does (09 §4, §9).

import type { MessageBlock, MessageItem } from "@session/shared";
import { memo } from "react";

import { cn } from "../../lib/cn.js";
import {
  ACTIVITY_PAYLOAD_CHAR_LIMIT,
  OVERSIZED_MARKDOWN_POLICY,
  RawTranscriptDisclosure,
  ResearchMarkdown,
  TranscriptActivityItem,
  timelineContextStatusClass,
  timelineStatusClass,
} from "../markdown/index.js";

import { RESPONSE_MESSAGE_CLASS } from "./selection/dom.js";

function unexpectedRoleLabel(role: string): string {
  if (role === "system") return "System content";
  if (role === "user") return "Additional user content";
  return `${role || "Unknown"} content`;
}

function MessageBlockView({ block, role }: { block: MessageBlock; role: string }) {
  if (block.type === "text") {
    if (role === "assistant") {
      return <ResearchMarkdown markdown={block.text} oversized={OVERSIZED_MARKDOWN_POLICY} />;
    }
    // A user turn inside a response is leakage, not content: render it as
    // literal text under a callout rather than as prose the reader might take
    // for the answer.
    return <p className="text-fg-muted text-sm whitespace-pre-wrap">{block.text}</p>;
  }
  return (
    <RawTranscriptDisclosure
      value={block.value}
      maxPayloadCharacters={ACTIVITY_PAYLOAD_CHAR_LIMIT}
      deferPayload
    />
  );
}

export const TimelineItem = memo(function TimelineItem({ item }: { item: MessageItem }) {
  const hasUnexpectedContent = item.role !== "assistant" && item.blocks.length > 0;
  return (
    <section
      className={cn(
        "flex min-w-0 flex-col gap-2",
        timelineContextStatusClass(item.contextStatus).trim(),
      )}
      data-timeline-key={item.key}
    >
      {item.contextStatus === "rolledBack" ? (
        <div className="text-fg-faint text-xs">Excluded from active context</div>
      ) : null}
      {item.blocks.length > 0 ? (
        <div
          className={cn(
            RESPONSE_MESSAGE_CLASS,
            "min-w-0",
            hasUnexpectedContent && "border-border-subtle rounded-md border border-dashed p-2",
            timelineStatusClass(item.status).trim(),
          )}
        >
          {hasUnexpectedContent ? (
            <span className="text-fg-faint text-xs">{unexpectedRoleLabel(item.role)}</span>
          ) : null}
          {item.blocks.map((block, index) => (
            <MessageBlockView key={`${item.key}-${index}`} block={block} role={item.role} />
          ))}
        </div>
      ) : null}
      {item.activities.map((activity) => (
        <TranscriptActivityItem
          key={activity.key}
          item={activity}
          isRootActivity
          maxPayloadCharacters={ACTIVITY_PAYLOAD_CHAR_LIMIT}
          deferPayloads
          showResultTokenCount={false}
        />
      ))}
    </section>
  );
});
