// The writes the screens make (02 §9.2), named after their mutators. Each
// makes its ids, hands the write to the replica (which predicts it, keeps the
// prediction and sends it) and reports the answer: a refusal shows its
// message as an alert toast and resolves `false`, so the caller keeps typed
// text in its composer. A write whose request failed is "Not sent": an item
// it created stays (the caller clears its composer, and `draft` names the
// composer its text returns to on Discard), and a write with no item shows
// the outbox toast (`NotSent.tsx`) instead of its confirmation.

import { QUEUED_RUNS_MAX, type ApiError } from "@session/mutators";
import type { Spaces } from "@session/shared";
import { useMemo } from "react";

import { showToast } from "../features/shell/Toast.js";

import { useReplica } from "./ReplicaProvider.js";
import type { Effort } from "./online.js";
import { queuedRunsOf } from "./queries.js";
import type { DraftRef, ReplicaSource, WriteOutcome } from "./source.js";
import { newUlid } from "./ulid.js";

type SpaceMutatorName = Spaces.SpaceMutatorName;

/** The toast of a run-starting write refused for a full queue (02 §5; at
 * most `QUEUED_RUNS_MAX` runs wait per person, 03 L1). */
export const QUEUE_FULL_MESSAGE = `You have ${QUEUED_RUNS_MAX} asks waiting to run. Try again when one starts.`;

/** The mention toast (02 §4.3, N16): "Notified @a, @b." and "@c isn't a
 * member." ("@c, @d aren't members."), joined when both apply. */
export function mentionToast(result: unknown): string | null {
  const r = (result ?? {}) as { notified?: string[]; notMembers?: string[] };
  const notified = r.notified ?? [];
  const missing = r.notMembers ?? [];
  const parts: string[] = [];
  if (notified.length) parts.push(`Notified ${notified.map((u) => `@${u}`).join(", ")}.`);
  if (missing.length)
    parts.push(
      `${missing.map((u) => `@${u}`).join(", ")} ${missing.length === 1 ? "isn't a member" : "aren't members"}.`,
    );
  return parts.length ? parts.join(" ") : null;
}

/** The text of a refused write's toast (02 §9.2): the queue toast for
 * `queue_full`, else the refusal's message. */
export function refusalText(error: ApiError): string {
  return error.reason === "queue_full" ? QUEUE_FULL_MESSAGE : error.message;
}

export interface Writes {
  /** Any write; resolves the outcome after showing a refusal. */
  send(name: SpaceMutatorName, input: unknown, draft?: DraftRef): Promise<WriteOutcome>;
  ask(
    space: string,
    q: string,
    model: string,
    effort: Effort,
    draft?: DraftRef,
  ): Promise<string | null>;
  post(space: string, q: string, draft?: DraftRef): Promise<string | null>;
  save(thread: string, on: boolean): Promise<boolean>;
  deleteThread(thread: string): Promise<boolean>;
  fork(input: {
    thread: string;
    parent: string;
    q: string;
    quote?: string | undefined;
    b?: number | undefined;
    model: string;
    effort: Effort;
    draft?: DraftRef | undefined;
  }): Promise<string | null>;
  lookUp(input: {
    thread: string;
    look: string;
    quote?: string | undefined;
    b?: number | undefined;
    model: string;
    effort: Effort;
    draft?: DraftRef | undefined;
  }): Promise<string | null>;
  deleteNode(thread: string, node: string): Promise<boolean>;
  promote(thread: string, node: string): Promise<string | null>;
  reply(thread: string, t: string, parent?: string, draft?: DraftRef): Promise<string | null>;
  deleteReply(id: string): Promise<boolean>;
  comment(
    thread: string,
    node: string,
    t: string,
    parent?: string,
    draft?: DraftRef,
  ): Promise<string | null>;
  join(space: string): Promise<boolean>;
  leave(space: string): Promise<boolean>;
  updateAbout(space: string, desc: string): Promise<boolean>;
  createChannel(input: {
    name: string;
    desc: string;
    vis: "open" | "private";
  }): Promise<WriteOutcome & { id?: string }>;
  setLayout(layout: "centred" | "wide"): Promise<boolean>;
}

export function makeWrites(source: ReplicaSource): Writes {
  const id = () => newUlid(source.now());
  const send = async (name: SpaceMutatorName, input: unknown, draft?: DraftRef) => {
    const outcome = await source.mutate(name, input, draft ? { draft } : {});
    if (!outcome.ok) showToast(refusalText(outcome.error), { alert: true });
    return outcome;
  };
  /** A write that starts a run: refused here, before it is sent, while 20
   * of the viewer's runs wait to start (02 §5, 03 L1); the server's
   * `queue_full` refusal gets the same toast. The caller keeps the text. */
  const run = async (
    name: SpaceMutatorName,
    input: { id: string } & Record<string, unknown>,
    draft?: DraftRef,
  ) => {
    if (queuedRunsOf(source) >= QUEUED_RUNS_MAX) {
      showToast(QUEUE_FULL_MESSAGE, { alert: true });
      return null;
    }
    return made(name, input, false, draft);
  };
  const made = async (
    name: SpaceMutatorName,
    input: { id: string } & Record<string, unknown>,
    mentions = false,
    draft?: DraftRef,
  ) => {
    const outcome = await send(name, input, draft);
    if (!outcome.ok) return null;
    if (mentions && !outcome.unsent) {
      const text = mentionToast(outcome.result);
      if (text) showToast(text);
    }
    return input.id;
  };
  /** Confirmed: not refused and not "Not sent" (its toast says so). */
  const done = async (name: SpaceMutatorName, input: unknown) => {
    const outcome = await send(name, input);
    return outcome.ok && !outcome.unsent;
  };
  return {
    send,
    ask: (space, q, model, effort, draft) =>
      run("threads.create", { id: id(), space, kind: "ask", q, model, effort }, draft),
    post: (space, q, draft) =>
      made("threads.create", { id: id(), space, kind: "post", q }, true, draft),
    save: async (thread, on) => {
      const ok = await done("saved.set", { kind: "thread", id: thread, on });
      if (ok) showToast(on ? "Saved." : "Removed from saved.");
      return ok;
    },
    deleteThread: (thread) => done("threads.delete", { id: thread }),
    fork: ({ quote, b, draft, ...rest }) =>
      run(
        "research.forkNode",
        {
          id: id(),
          ...rest,
          kind: "ask",
          ...(quote !== undefined ? { quote } : {}),
          ...(b !== undefined ? { b } : {}),
        },
        draft,
      ),
    lookUp: ({ quote, b, draft, ...rest }) =>
      run(
        "research.forkNode",
        {
          id: id(),
          ...rest,
          parent: "r",
          kind: "lookup",
          ...(quote !== undefined ? { quote } : {}),
          ...(b !== undefined ? { b } : {}),
        },
        draft,
      ),
    deleteNode: (thread, node) => done("followups.delete", { thread, node }),
    promote: async (thread, node) => {
      const made_ = await made("threads.create", { id: id(), from: { th: thread, node } });
      if (made_) showToast("Opened as its own thread.");
      return made_;
    },
    reply: (thread, t, parent, draft) =>
      made(
        "research.createPostFollowUp",
        { id: id(), thread, t, ...(parent !== undefined ? { parent } : {}) },
        true,
        draft,
      ),
    deleteReply: (reply) => done("replies.delete", { id: reply }),
    comment: (thread, node, t, parent, draft) =>
      made(
        "comments.create",
        { id: id(), thread, node, t, ...(parent !== undefined ? { parent } : {}) },
        true,
        draft,
      ),
    join: (space) => done("spaces.join", { space }),
    leave: (space) => done("spaces.leave", { space }),
    updateAbout: (space, desc) => done("spaces.update", { id: space, desc }),
    createChannel: async ({ name, desc, vis }) => {
      const channel = id();
      const outcome = await source.mutate("spaces.create", {
        id: channel,
        name,
        ...(desc ? { desc } : {}),
        vis,
      });
      return outcome.ok ? { ...outcome, id: channel } : outcome;
    },
    setLayout: (layout) => done("prefs.set", { layout }),
  };
}

export function useWrites(): Writes {
  const source = useReplica();
  return useMemo(() => makeWrites(source), [source]);
}
