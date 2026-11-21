// Context assembly for a run (`03-agents-and-research.md` G7).
//
// Every attempt rebuilds its context from the thread's stored records: for
// each ancestor from the root to the parent, its question and its answer
// (the committed turns of the attempt that answered it, or the answer's
// Markdown when those turns are not stored, as for a thread opened from a
// branch), then the new node's question. Branch here and Look up add their
// passage (`quote`) to the new user message as a quoted passage. A Branch's
// context is its parent's path; the sibling it was started beside is not
// on it. Reasoning blocks are dropped across models later, when the loop
// builds the request (`messages.ts`, `ancestorContext`); the budget rules of
// `04-agent-runtime.md` §4 cut what is over the window.

import {
  answerKey,
  nodeKey,
  threadKey,
  type NodeRec,
  type Reads,
  type RunRec,
  type ThreadRec,
  type TurnRec,
} from "@session/mutators";
import type { Turn, TurnBlock } from "@session/shared";
import type { ModelMessage } from "ai";

import { messagesFromCommittedTurns } from "./messages.js";
import { researchUserText } from "./prompts.js";
import type { ContextMessage, RunRequest } from "./store.js";

/** What a run's records say about the attempt to run. */
export type RunContext = Pick<RunRequest, "node" | "userText" | "history" | "finalSteps">;

/** A turn record as the loop's `Turn`s (`mapper.ts`). One record holds one
 * provider step: the assistant's text and tool calls, then the results of
 * those calls (`toolResult` blocks), which the mapper hands over as a
 * second, user turn; they come back apart. A record's `tool` role is a
 * user turn of tool results stored alone. */
export function turnsOf(r: TurnRec): Turn[] {
  const blocks = r.blocks as unknown as TurnBlock[];
  const turn = (role: string, b: TurnBlock[]): Turn => ({
    id: `${r.run}-${role}-${r.n}`,
    agentId: r.run,
    role,
    blocks: b,
    sourceIndex: r.n,
  });
  if (r.role !== "assistant") return [turn("user", blocks)];
  const results = blocks.filter((b) => b.type === "toolResult");
  const own = blocks.filter((b) => b.type !== "toolResult");
  return results.length > 0
    ? [turn("assistant", own), turn("user", results)]
    : [turn("assistant", own)];
}

/** The role a `Turn` is stored with. */
export function roleOf(turn: Turn): TurnRec["role"] {
  if (turn.role === "assistant") return "assistant";
  return turn.blocks.length > 0 && turn.blocks.every((b) => b.type === "toolResult")
    ? "tool"
    : "user";
}

/** The committed turns of one attempt of a run, by number. */
export function attemptTurns(tx: Reads, th: string, run: string, attempt: number): TurnRec[] {
  return tx
    .list("turn", { th })
    .filter((x) => x.run === run && x.attempt === attempt)
    .sort((a, b) => a.n - b.n);
}

type Ask = ThreadRec | NodeRec;

/** The asks from the root to `n`'s parent, root first. */
function ancestors(tx: Reads, root: ThreadRec, n: NodeRec): Ask[] {
  const path: Ask[] = [];
  const seen = new Set<string>();
  let par = n.par;
  while (par !== "r" && !seen.has(par)) {
    seen.add(par);
    const p = tx.byKey(nodeKey(par));
    if (p?.kind !== "node") break;
    path.unshift(p);
    par = p.par;
  }
  return [root, ...path];
}

/** An ask's exchange as stored: its question, then its answer. */
function exchange(tx: Reads, root: ThreadRec, ask: Ask): ContextMessage[] {
  const id = ask.id;
  const model = ask.model;
  const question: ModelMessage = {
    role: "user",
    content: researchUserText({
      prompt: ask.q,
      passage: ask.kind === "node" ? ask.quote : null,
    }),
  };
  const out: ContextMessage[] = [{ nodeId: id, message: question, model: null }];
  const answer = tx.byKey(answerKey(id));
  if (answer?.kind !== "answer") return out;
  const turns = attemptTurns(tx, root.id, answer.run, answer.attempt).flatMap(turnsOf);
  const replies =
    turns.length > 0
      ? messagesFromCommittedTurns(turns)
      : [{ role: "assistant", content: answer.md } as ModelMessage];
  for (const message of replies) out.push({ nodeId: id, message, model });
  return out;
}

/** The context of `run`, from the records `tx` reads; null when its thread or
 * ask is gone. */
export function runContext(tx: Reads, run: RunRec): RunContext | null {
  const root = tx.byKey(threadKey(run.th));
  if (root?.kind !== "thread") return null;
  if (run.node === "r") {
    return {
      node: "ask",
      userText: researchUserText({ prompt: root.q }),
      history: [],
      // a new thread's title (unless its author gave one) and the root
      // answer's summary line are the run's final steps (`03` E2)
      finalSteps: { title: root.t === null, summary: true },
    };
  }
  const n = tx.byKey(nodeKey(run.node));
  if (n?.kind !== "node") return null;
  return {
    node: n.k,
    userText: researchUserText({ prompt: n.q, passage: n.quote }),
    history: ancestors(tx, root, n).flatMap((ask) => exchange(tx, root, ask)),
  };
}
