import { useEffect, useMemo, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import type { ResearchNode, ResearchTreeDetail } from "../../types";
import { getResearchNodeContent } from "../../lib/api";
import { recentResearchQueryFromNode } from "../../lib/activity";
import { IS_MAC } from "../../lib/appHelpers";
import { formatRelativeTime } from "../../lib/transcriptSessions";
import {
  assistantTextFromTimelineItems,
  buildTimelineItems,
  timelineItemsAfterLastToolCall,
} from "../../lib/turnTimeline";
import { formatResearchModelSummary } from "../../lib/researchModelSummary";
import { ResearchDocumentFrame, ResearchSidebarRestoreButton } from "./ResearchDocumentChrome";
import { ResearchMarkdown, ResearchUserMessage } from "./ResearchMessage";
import {
  NoteBody,
  NoteFollowUpField,
  NoteFollowUpStatus,
  NoteReplyThread,
  noteReplyTargetFor,
  type NoteActions,
  type NoteReplyTarget,
} from "./ResearchNote";
import ResearchThreadActions from "./ResearchThreadActions";

function excerpt(text: string, maxChars = 90): string {
  const normalized = text.split(/\s+/).filter(Boolean).join(" ");
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars - 1).trimEnd()}…` : normalized;
}

/** Final answer text of each completed AI follow-up, refetched when a run's
 * response snapshot lands or changes. */
function useFollowUpAnswers(children: ResearchNode[]) {
  const [answers, setAnswers] = useState<Record<string, { key: string; text: string }>>({});
  const answersRef = useRef(answers);
  answersRef.current = answers;
  const wanted = children
    .filter((child) => (child.kind ?? "run") === "run" && child.status === "complete")
    .map((child) => `${child.id}:${child.responseSnapshotAt ?? 0}`);
  const wantedKey = wanted.join("|");
  useEffect(() => {
    let cancelled = false;
    for (const key of wantedKey ? wantedKey.split("|") : []) {
      const id = key.slice(0, key.lastIndexOf(":"));
      if (answersRef.current[id]?.key === key) continue;
      void getResearchNodeContent(id)
        .then((content) => {
          if (cancelled) return;
          const text = assistantTextFromTimelineItems(
            timelineItemsAfterLastToolCall(buildTimelineItems(content.turns)),
          ).trim();
          setAnswers((current) => ({ ...current, [id]: { key, text } }));
        })
        .catch(() => {
          if (!cancelled) {
            setAnswers((current) => ({ ...current, [id]: { key, text: "" } }));
          }
        });
    }
    return () => {
      cancelled = true;
    };
  }, [wantedKey]);
  return answers;
}

/** A note's page: the note, its Replies group (network notes only), then
 * its follow-ups as stacked segments, oldest first, and a follow-up field.
 * Opening an AI follow-up selects that run's own page, where highlights and
 * branching work as for any answer. */
export default function ResearchNoteDocument({
  detail,
  note,
  archived,
  followed,
  bookmarked,
  actions,
  canGoBack,
  canGoForward,
  onBack,
  onForward,
  onShowSidebar,
  onToggleFollow,
  onToggleBookmark,
  onSelectNode,
}: {
  detail: ResearchTreeDetail;
  note: ResearchNode;
  archived: boolean;
  followed: boolean;
  bookmarked: boolean;
  actions: NoteActions;
  canGoBack: boolean;
  canGoForward: boolean;
  onBack: () => void;
  onForward: () => void;
  onShowSidebar?: () => void;
  onToggleFollow: () => void;
  onToggleBookmark: () => void;
  onSelectNode: (nodeId: string) => void;
}) {
  const [target, setTarget] = useState<NoteReplyTarget | null>(null);
  const children = useMemo(
    () =>
      detail.nodes
        .filter((node) => node.parentNodeId === note.id)
        .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id)),
    [detail.nodes, note.id],
  );
  const answers = useFollowUpAnswers(children);
  const parent = note.parentNodeId
    ? detail.nodes.find((node) => node.id === note.parentNodeId) ?? null
    : null;
  const isRoot = note.id === detail.tree.rootNodeId;
  const replies = note.delivery?.replies ?? [];
  const topLevelReplies = replies.filter((reply) => !reply.inReplyTo).length;
  const modelLabel = formatResearchModelSummary(note.adapter, note.model);
  const deliveryLabel = note.delivery
    ? "Posted to network"
    : note.attachments?.some((attachment) => attachment.tweet)
      ? "Saved post"
      : "Saved link";
  return (
    <ResearchDocumentFrame
      title={detail.tree.title}
      canGoBack={canGoBack}
      canGoForward={canGoForward}
      backTitle={`Back (${IS_MAC ? "⌘[" : "Ctrl+["})`}
      forwardTitle={`Forward (${IS_MAC ? "⌘]" : "Ctrl+]"})`}
      onBack={onBack}
      onForward={onForward}
      headerActions={
        onShowSidebar ? <ResearchSidebarRestoreButton onClick={onShowSidebar} /> : undefined
      }
    >
      <article className="research-document-scroll">
        <div className="research-document-content research-reading-surface note-document">
          <div className="research-prompt-block">
            {parent ? (
              <button
                type="button"
                className="note-document-parent"
                onClick={() => onSelectNode(parent.id)}
              >
                ↳ Network follow-up of “{excerpt(parent.prompt, 60)}”
              </button>
            ) : (
              <span className="note-document-kind">Note</span>
            )}
            <ResearchUserMessage className="research-prompt has-trailing-metadata">
              <NoteBody prompt={note.prompt} attachments={note.attachments} />
            </ResearchUserMessage>
            <div className="research-prompt-footer">
              {isRoot ? (
                <ResearchThreadActions
                  followed={followed}
                  bookmarked={bookmarked}
                  onToggleFollow={onToggleFollow}
                  onToggleBookmark={onToggleBookmark}
                />
              ) : null}
              <span className="research-prompt-metadata research-prompt-footer-meta">
                {deliveryLabel} · {formatRelativeTime(note.createdAt)}
              </span>
            </div>
          </div>

          {note.delivery ? (
            <section className="note-document-group" aria-label="Replies">
              <h2 className="note-document-group-label">
                Replies{topLevelReplies > 0 ? ` · ${topLevelReplies}` : ""}
              </h2>
              {replies.length > 0 ? (
                <NoteReplyThread
                  nodeId={note.id}
                  replies={replies}
                  archived={archived}
                  actions={actions}
                  onAskAbout={setTarget}
                />
              ) : (
                <p className="note-document-placeholder">
                  No replies yet. Replies from your network will appear here.
                </p>
              )}
            </section>
          ) : null}

          <section className="note-document-group" aria-label="Follow-ups">
            {children.length > 0 ? (
              <h2 className="note-document-group-label">Follow-ups · {children.length}</h2>
            ) : null}
            {children.map((child) => {
              const summary = recentResearchQueryFromNode(child, true);
              if (!summary) return null;
              const childIsNote = child.kind === "note";
              const childReplies = child.delivery?.replies?.filter((reply) => !reply.inReplyTo).length ?? 0;
              const anchored = noteReplyTargetFor(replies, child.replyAnchor);
              const anchoredReply = anchored
                ? replies.find((reply) => reply.id === anchored.id)
                : undefined;
              const answer = answers[child.id]?.text;
              return (
                <div key={child.id} className="note-segment">
                  <div className="note-segment-meta">
                    ↳{" "}
                    {childIsNote
                      ? `Posted to network · ${
                          childReplies === 1 ? "1 reply" : `${childReplies} replies`
                        }`
                      : formatResearchModelSummary(child.adapter, child.model) || "Follow-up"}
                    {anchored ? ` · about ${anchored.author}’s reply` : ""}
                  </div>
                  {anchoredReply ? (
                    <div className="research-prompt-quote">{excerpt(anchoredReply.body, 240)}</div>
                  ) : null}
                  <div
                    className="note-segment-question"
                    role="button"
                    tabIndex={0}
                    title={childIsNote ? "Open this follow-up" : "Open this answer"}
                    onClick={() => onSelectNode(child.id)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      onSelectNode(child.id);
                    }}
                  >
                    {child.prompt}
                  </div>
                  {childIsNote ? null : child.status === "complete" ? (
                    answer === undefined ? (
                      <LoaderCircle className="note-segment-spinner" size={14} aria-hidden="true" />
                    ) : answer ? (
                      <ResearchMarkdown className="note-segment-answer" text={answer} />
                    ) : (
                      <p className="note-document-placeholder">The answer is unavailable.</p>
                    )
                  ) : (
                    <NoteFollowUpStatus
                      child={summary}
                      modelLabel={modelLabel}
                      archived={archived}
                      onRetry={actions.onRetry}
                    />
                  )}
                </div>
              );
            })}
            {!archived ? (
              <NoteFollowUpField
                key={target?.id ?? "note"}
                networkAvailable={Boolean(note.delivery)}
                modelLabel={modelLabel}
                target={target}
                autoFocus={target !== null}
                placeholder="Ask a follow-up about this note"
                onClearTarget={() => setTarget(null)}
                onSubmit={(prompt, network) =>
                  actions
                    .onAskFollowUp({
                      parentNodeId: note.id,
                      prompt,
                      network,
                      replyAnchor: network ? null : target?.id ?? null,
                    })
                    .then(() => setTarget(null))
                }
              />
            ) : null}
          </section>
        </div>
      </article>
    </ResearchDocumentFrame>
  );
}
