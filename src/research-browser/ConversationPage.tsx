import { useEffect, useRef, useState } from "react";
import ResearchRecap from "../components/research/ResearchRecap";
import TranscriptMarkdown, {
  TranscriptLinkActionsProvider,
} from "../components/TranscriptMarkdown";
import {
  RawTranscriptDisclosure,
  TranscriptActivityItem,
} from "../components/TranscriptActivity";
import {
  buildTimelineItems,
  timelineItemsAfterLastToolCall,
  timelineItemsContainTranscriptActivity,
  type MessageItem,
} from "../lib/turnTimeline";
import {
  canContinueThread,
  canFollowUpFrom,
  canRetryResearchNode,
  isActiveResearchStatus,
} from "../lib/researchThreads";
import type {
  ResearchNode,
  ResearchNodeContent,
  ResearchNodeStatus,
  ResearchTreeDetail,
} from "../types";
import type { ResearchBrowserSdk } from "./sdk";
import { conversationPath, researchRoute } from "./conversation";
import { saveViewStateSoon } from "./viewState";

// Mirrors the research document's caps: oversized markdown falls back to
// capped plain text, and tool payloads are truncated rather than laid out.
const MARKDOWN_CHAR_LIMIT = 100_000;
const PLAINTEXT_DISPLAY_CHAR_LIMIT = 1_000_000;
const ACTIVITY_PAYLOAD_CHAR_LIMIT = 200_000;
const OVERSIZED_MARKDOWN_POLICY = {
  maxCharacters: MARKDOWN_CHAR_LIMIT,
  maxDisplayCharacters: PLAINTEXT_DISPLAY_CHAR_LIMIT,
  fallbackClassName: "research-plaintext",
} as const;

const STATUS_LABELS: Record<ResearchNodeStatus, string> = {
  queued: "Queued",
  starting: "Starting",
  running: "Running",
  complete: "Complete",
  failed: "Failed",
  cancelled: "Cancelled",
};

function nodeLabel(node: ResearchNode) {
  return node.title || node.prompt.slice(0, 80) || "Document";
}

export default function ConversationPage({
  sdk,
  treeId,
  nodeId,
}: {
  sdk: ResearchBrowserSdk;
  treeId: string;
  nodeId?: string;
}) {
  const [data, setData] = useState<{
    detail: ResearchTreeDetail;
    contents: ResearchNodeContent[];
  }>();
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);
  const draftKey = `followup:${treeId}:${nodeId ?? "root"}`;
  const [draft, setDraft] = useState(() =>
    String(sdk.getSnapshot().viewState[draftKey] ?? ""),
  );
  const refreshRef = useRef(() => {});
  const scrollRef = useRef<HTMLDivElement>(null);
  const restoredScroll = useRef(false);
  const scrollKey = `scroll:${treeId}:${nodeId ?? "root"}`;
  useEffect(() => {
    let disposed = false,
      loading = false,
      dirty = false;
    let nextPoll = 0;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      if (disposed) return;
      if (loading) {
        dirty = true;
        return;
      }
      loading = true;
      try {
        const detail = await sdk.call("research.getTree", treeId);
        const path = conversationPath(detail, nodeId);
        const contents = await Promise.all(
          path.map((node) => sdk.call("research.getNodeContent", node.id)),
        );
        if (!disposed) {
          setData({ detail, contents });
          setLoadError("");
          nextPoll =
            Date.now() +
            (path.some((node) => isActiveResearchStatus(node.status))
              ? 3000
              : 30000);
        }
      } catch (error) {
        if (!disposed) setLoadError(String(error));
      } finally {
        loading = false;
        if (dirty && !disposed) {
          dirty = false;
          void refresh();
        }
      }
    };
    const schedule = () => {
      if (!debounce)
        debounce = setTimeout(() => {
          debounce = undefined;
          void refresh();
        }, 150);
    };
    refreshRef.current = () => {
      void refresh();
    };
    const unsubscribe = sdk.subscribe((name) => {
      if (name === "research.changed" || name === "reconnected") schedule();
    });
    void refresh();
    // Recover dropped events and keep running transcripts live without overlapping reads.
    const poll = setInterval(() => {
      if (!document.hidden && Date.now() >= nextPoll) void refresh();
    }, 3000);
    const focus = () => {
      if (!document.hidden) schedule();
    };
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", focus);
    void sdk.call("research.markViewed", treeId).catch(() => {});
    return () => {
      disposed = true;
      clearInterval(poll);
      clearTimeout(debounce);
      unsubscribe();
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", focus);
    };
  }, [sdk, treeId, nodeId]);
  useEffect(() => {
    if (data && !restoredScroll.current && scrollRef.current) {
      scrollRef.current.scrollTop = Number(
        sdk.getSnapshot().viewState[scrollKey] ?? 0,
      );
      restoredScroll.current = true;
    }
  }, [data, sdk, scrollKey]);

  const run = async (operation: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await operation();
      refreshRef.current();
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  };
  const target = data?.contents[data.contents.length - 1]?.node;
  const archived = Boolean(data?.detail.tree.archivedAt);
  const canFork = Boolean(
    target && !archived && draft.trim() && canFollowUpFrom(target),
  );
  const canContinue = Boolean(
    target &&
    data &&
    !archived &&
    draft.trim() &&
    canContinueThread(data.detail.nodes, target),
  );
  const fork = (inline: boolean) =>
    run(async () => {
      if (!target || !draft.trim()) return;
      const child = await sdk.call(
        "research.fork",
        target.id,
        draft.trim(),
        null,
        null,
        inline,
      );
      await sdk.call("viewState.save", draftKey, "");
      setDraft("");
      await sdk.call("navigation.go", researchRoute(treeId, child.id));
    });
  const openLink = (url: string) => {
    void sdk
      .call("ui.openExternalUrl", url)
      .catch((error) => setError(String(error)));
  };
  const followupHint = archived
    ? "This research is archived. Restore it in Session to add a follow-up."
    : target && !canFollowUpFrom(target)
      ? isActiveResearchStatus(target.status)
        ? "Follow-ups become available once this response completes."
        : "Follow-ups need a completed response with a resumable session."
      : "⌘↵ continues inline · ⇧⌘↵ forks a new branch";
  return (
    <div
      className="research-browser-conversation"
      ref={scrollRef}
      onScroll={(event) => {
        saveViewStateSoon(sdk, scrollKey, event.currentTarget.scrollTop);
      }}
    >
      <div className="research-browser-conversation-content">
        {error && (
          <div role="alert" className="research-browser-alert">
            <span>{error}</span>
            <button
              type="button"
              className="control-button"
              onClick={() => setError("")}
            >
              Dismiss
            </button>
          </div>
        )}
        {loadError && (
          <div role="alert" className="research-browser-alert">
            <span>{loadError}</span>
            <button
              type="button"
              className="control-button"
              onClick={() => refreshRef.current()}
            >
              Retry loading
            </button>
          </div>
        )}
        {!data ? (
          !loadError && (
            <p className="research-browser-placeholder">
              Loading conversation…
            </p>
          )
        ) : (
          <>
            <header className="research-browser-conversation-nav">
              <h1 className="research-browser-title">
                {data.detail.tree.title}
              </h1>
              <div className="research-browser-nav-row">
                <label className="research-browser-node-picker">
                  <span>Branch or turn</span>
                  <select
                    className="form-field"
                    value={target?.id ?? ""}
                    onChange={(event) => {
                      void sdk
                        .call(
                          "navigation.go",
                          researchRoute(treeId, event.target.value),
                        )
                        .catch((error) => setError(String(error)));
                    }}
                  >
                    {data.detail.nodes.map((node) => (
                      <option key={node.id} value={node.id}>
                        {nodeLabel(node)} ·{" "}
                        {STATUS_LABELS[node.status].toLowerCase()}
                      </option>
                    ))}
                  </select>
                </label>
                {target && (
                  <div className="research-browser-nav-actions">
                    {isActiveResearchStatus(target.status) && (
                      <button
                        type="button"
                        className="control-button"
                        disabled={busy}
                        onClick={() => {
                          void run(() =>
                            sdk.call("research.cancel", target.id),
                          );
                        }}
                      >
                        Cancel run
                      </button>
                    )}
                    {!archived && canRetryResearchNode(target) && (
                      <button
                        type="button"
                        className="control-button"
                        disabled={busy}
                        onClick={() => {
                          void run(() => sdk.call("research.retry", target.id));
                        }}
                      >
                        Retry run
                      </button>
                    )}
                    <button
                      type="button"
                      className="control-button"
                      onClick={() => {
                        void run(() =>
                          sdk.call(
                            "navigation.openDocument",
                            treeId,
                            target.id,
                          ),
                        );
                      }}
                    >
                      Open in document view
                    </button>
                  </div>
                )}
              </div>
            </header>
            <TranscriptLinkActionsProvider
              actions={{ openLink, openLinkMenu: openLink }}
            >
              {data.contents.map((content) => (
                <ConversationSegment key={content.node.id} content={content} />
              ))}
            </TranscriptLinkActionsProvider>
            {target && (
              <section
                className="research-browser-followup"
                aria-label="Follow-up"
              >
                <label
                  className="research-browser-followup-label"
                  htmlFor="research-browser-followup-input"
                >
                  Follow-up
                </label>
                <textarea
                  id="research-browser-followup-input"
                  className="form-field research-browser-followup-input"
                  value={draft}
                  placeholder="Ask a follow-up…"
                  rows={3}
                  disabled={archived}
                  onChange={(event) => {
                    const value = event.target.value;
                    setDraft(value);
                    void sdk
                      .call("viewState.save", draftKey, value)
                      .catch((error) => setError(String(error)));
                  }}
                  onKeyDown={(event) => {
                    if (
                      event.key !== "Enter" ||
                      !(event.metaKey || event.ctrlKey) ||
                      busy
                    )
                      return;
                    // ⌘↵ continues inline when possible (falling back to a
                    // fork); ⇧⌘↵ always forks.
                    const inline = !event.shiftKey && canContinue;
                    if (!inline && !canFork) return;
                    event.preventDefault();
                    void fork(inline);
                  }}
                />
                <div className="research-browser-followup-footer">
                  <small className="research-browser-followup-hint">
                    {followupHint}
                  </small>
                  <div className="research-browser-followup-actions">
                    <button
                      type="button"
                      className="control-button"
                      disabled={busy || !canFork}
                      onClick={() => {
                        void fork(false);
                      }}
                    >
                      Fork branch
                    </button>
                    <button
                      type="button"
                      className="control-button"
                      disabled={busy || !canContinue}
                      onClick={() => {
                        void fork(true);
                      }}
                    >
                      Continue inline
                    </button>
                  </div>
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function ConversationSegment({ content }: { content: ResearchNodeContent }) {
  const [showTrace, setShowTrace] = useState(false);
  const { node } = content;
  const kind = node.kind ?? "run";
  const isConversation = kind === "conversation";
  // Same fold as the research document: a run shows the answer that follows
  // its last tool call, with the full trace one click away; a conversation
  // is its whole timeline.
  const items = buildTimelineItems(content.turns);
  const answerItems = timelineItemsAfterLastToolCall(items);
  const hasActivity =
    !isConversation && timelineItemsContainTranscriptActivity(items);
  const shown = isConversation || showTrace ? items : answerItems;
  const active = isActiveResearchStatus(node.status);
  return (
    <article className="research-browser-segment">
      {/* A document is its own content and a conversation opens with its
          first user turn, so only a run repeats its prompt as a card. */}
      {kind === "run" && node.prompt && (
        <div className="research-prompt">
          <TranscriptMarkdown text={node.prompt} imageBehavior="open" />
        </div>
      )}
      {node.error && <p className="research-response-error">{node.error}</p>}
      {content.sourceError && (
        <p className="research-response-error">{content.sourceError}</p>
      )}
      <ResearchRecap content={content} />
      {shown.length > 0 ? (
        <div className="research-response-content-root">
          {shown.map((item) => (
            <TimelineItemView
              key={item.key}
              item={item}
              conversation={isConversation}
            />
          ))}
        </div>
      ) : node.error || content.sourceError ? null : (
        <p className="research-browser-empty">
          {active
            ? items.length > 0
              ? "Waiting for the final response…"
              : "Working…"
            : node.status === "complete"
              ? "No response is available."
              : `Run ${STATUS_LABELS[node.status].toLowerCase()} before a response was available.`}
        </p>
      )}
      <footer className="research-answer-meta research-browser-segment-meta">
        <span className="research-browser-status">
          <span
            className={`research-browser-status-dot is-${node.status}`}
            aria-hidden="true"
          />
          {STATUS_LABELS[node.status]}
        </span>
        <span>
          {node.adapter}
          {node.model ? ` · ${node.model}` : ""}
        </span>
        {hasActivity && (
          <button
            type="button"
            className="research-browser-link-button"
            onClick={() => setShowTrace((value) => !value)}
          >
            {showTrace ? "Hide transcript activity" : "Show full transcript"}
          </button>
        )}
      </footer>
    </article>
  );
}

function TimelineItemView({
  item,
  conversation,
}: {
  item: MessageItem;
  conversation: boolean;
}) {
  const isPrompt = conversation && item.role === "user";
  const unexpected =
    !conversation && item.role !== "assistant" && item.blocks.length > 0;
  return (
    <section
      className={`research-response-item role-${item.role}${
        conversation ? " is-conversation" : ""
      }`}
      data-timeline-key={item.key}
    >
      {item.blocks.length > 0 && (
        <div
          className={`research-response-message${
            isPrompt ? " research-conversation-prompt research-prompt" : ""
          }${unexpected ? " research-unexpected-content" : ""}`}
        >
          {unexpected && (
            <span>{item.role === "user" ? "User message" : item.role}</span>
          )}
          {item.blocks.map((block, index) =>
            block.type === "text" ? (
              item.role === "assistant" || conversation ? (
                <TranscriptMarkdown
                  key={index}
                  text={block.text}
                  imageBehavior="open"
                  oversizedContent={OVERSIZED_MARKDOWN_POLICY}
                />
              ) : (
                <p key={index} className="research-unexpected-text">
                  {block.text}
                </p>
              )
            ) : (
              <RawTranscriptDisclosure
                key={index}
                value={block.value}
                maxPayloadCharacters={ACTIVITY_PAYLOAD_CHAR_LIMIT}
                deferPayload
              />
            ),
          )}
        </div>
      )}
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
}
