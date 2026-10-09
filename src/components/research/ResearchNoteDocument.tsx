import { useEffect, useMemo, useRef, useState } from "react";
import { Globe, LoaderCircle, Sparkles } from "lucide-react";
import type { NoteReply, ResearchNode, ResearchTreeDetail } from "../../types";
import { getResearchNodeContent } from "../../lib/api";
import { recentResearchQueryFromNode } from "../../lib/activity";
import { formatRelativeTime } from "../../lib/transcriptSessions";
import {
  assistantTextFromTimelineItems,
  buildTimelineItems,
  timelineItemsAfterLastToolCall,
} from "../../lib/turnTimeline";
import { formatResearchModelSummary } from "../../lib/researchModelSummary";
import { ResearchMarkdown, ResearchUserMessage } from "./ResearchMessage";
import {
  NoteBody,
  NoteFollowUpField,
  NoteFollowUpStatus,
  NoteReplyItem,
  noteReplyTargetFor,
  type NoteActions,
  type NoteReplyTarget,
} from "./ResearchNote";

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

type ActivityEntry =
  | { kind: "reply"; at: number; reply: NoteReply }
  | { kind: "follow-up"; at: number; node: ResearchNode };

/** A note's page, as the body of a column: the note as its heading, then one
 * Activity list of replies (network notes only) and follow-ups in the order
 * they happened, then the follow-up field. Opening an AI follow-up opens that
 * run as a branch, where highlights and branching work as for any answer. The
 * column header carries the title, Follow and Bookmark. */
export default function ResearchNoteDocument({
  detail,
  note,
  archived,
  actions,
  onSelectNode,
}: {
  detail: ResearchTreeDetail;
  note: ResearchNode;
  archived: boolean;
  actions: NoteActions;
  onSelectNode: (nodeId: string) => void;
}) {
  const [target, setTarget] = useState<NoteReplyTarget | null>(null);
  const children = useMemo(
    () =>
      detail.nodes
        // Documents never list as follow-ups.
        .filter((node) => node.parentNodeId === note.id && node.kind !== "document")
        .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id)),
    [detail.nodes, note.id],
  );
  const answers = useFollowUpAnswers(children);
  const parent = note.parentNodeId
    ? detail.nodes.find((node) => node.id === note.parentNodeId) ?? null
    : null;
  const replies = note.delivery?.replies ?? [];
  const topLevelReplies = replies.filter((reply) => !reply.inReplyTo);
  const modelLabel = formatResearchModelSummary(note.adapter, note.model);
  const deliveryLabel = note.delivery
    ? "Posted to network"
    : note.attachments?.some((attachment) => attachment.tweet)
      ? "Saved post"
      : "Saved link";
  const activity: ActivityEntry[] = [
    ...topLevelReplies.map((reply) => ({ kind: "reply" as const, at: reply.createdAt, reply })),
    ...children.map((node) => ({ kind: "follow-up" as const, at: node.createdAt, node })),
  ].sort((left, right) => left.at - right.at);

  const renderFollowUp = (child: ResearchNode) => {
    const summary = recentResearchQueryFromNode(child, true);
    if (!summary) return null;
    const childIsNote = child.kind === "note";
    const childReplies = child.delivery?.replies?.filter((reply) => !reply.inReplyTo).length ?? 0;
    const anchored = noteReplyTargetFor(replies, child.replyAnchor);
    const answer = answers[child.id]?.text;
    const childModel = formatResearchModelSummary(child.adapter, child.model) || "AI";
    return (
      <li key={child.id} className="note-thread-item" data-type="follow-up">
        <div className="note-thread-gutter">
          <span className="note-glyph" aria-hidden="true">
            {childIsNote ? <Globe size={11} /> : <Sparkles size={11} />}
          </span>
        </div>
        <div className="note-thread-body">
          <div className="note-reply-head">
            <span className="note-reply-author">You</span>
            <span>
              {childIsNote
                ? "posted to network"
                : `asked ${childModel}${anchored ? ` about ${anchored.author}’s reply` : ""}`}
            </span>
            <span aria-hidden="true">·</span>
            <time
              dateTime={new Date(child.createdAt).toISOString()}
              title={new Date(child.createdAt).toLocaleString()}
            >
              {formatRelativeTime(child.createdAt)}
            </time>
          </div>
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
          {childIsNote ? (
            <div className="note-thread-meta">
              {childReplies === 1 ? "1 reply" : childReplies > 0 ? `${childReplies} replies` : "No replies yet"}
            </div>
          ) : child.status === "complete" ? (
            answer === undefined ? (
              <LoaderCircle className="note-segment-spinner" size={14} aria-hidden="true" />
            ) : answer ? (
              <>
                <ResearchMarkdown
                  className="note-segment-answer is-clamped"
                  text={answer}
                  variant="compact"
                />
                <button
                  type="button"
                  className="note-thread-link note-segment-open"
                  onClick={() => onSelectNode(child.id)}
                >
                  Open answer
                </button>
              </>
            ) : (
              <p className="note-thread-meta">The answer is unavailable.</p>
            )
          ) : (
            <NoteFollowUpStatus
              child={summary}
              archived={archived}
              onRetry={actions.onRetry}
            />
          )}
        </div>
      </li>
    );
  };

  return (
    <div className="note-document">
      <div className="research-prompt-block">
        {parent ? (
          <button
            type="button"
            className="note-document-parent"
            onClick={() => onSelectNode(parent.id)}
          >
            ↳ Network follow-up of “{excerpt(parent.prompt, 60)}”
          </button>
        ) : null}
        <ResearchUserMessage className="research-prompt note-document-heading has-trailing-metadata">
          <NoteBody prompt={note.prompt} attachments={note.attachments} />
        </ResearchUserMessage>
        <div className="note-document-meta">
          <span className="research-prompt-metadata">
            {deliveryLabel} · {formatRelativeTime(note.createdAt)}
            {note.delivery && topLevelReplies.length === 0 ? " · No replies yet" : ""}
          </span>
        </div>
      </div>

      {activity.length > 0 ? (
        <section className="note-document-group" aria-label="Activity">
          <h2 className="note-document-group-label">
            Activity <span className="note-document-group-count">{activity.length}</span>
          </h2>
          <ol className="note-thread-list">
            {activity.map((entry) =>
              entry.kind === "reply" ? (
                <NoteReplyItem
                  key={entry.reply.id}
                  nodeId={note.id}
                  reply={entry.reply}
                  responses={replies.filter((reply) => reply.inReplyTo === entry.reply.id)}
                  archived={archived}
                  actions={actions}
                  onAskAbout={setTarget}
                />
              ) : (
                renderFollowUp(entry.node)
              ),
            )}
          </ol>
        </section>
      ) : null}

      {!archived ? (
        <div className="note-document-composer">
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
        </div>
      ) : null}
    </div>
  );
}
