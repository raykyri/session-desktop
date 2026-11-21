// An ask's tree as the side column reads it (the mock's `tree(p)`): children
// in creation order, depth-first rows, the path to a node, and the groups of
// top-level branches per passage (02 §4.1).

import type { AnswerRec, CommentRec, NodeRec, RunRec } from "@session/mutators";

import type { AskTree } from "../../replica/queries.js";

export interface TreeIndex {
  nodes: Map<string, NodeRec>;
  kids: (id: string) => NodeRec[];
  /** Root first, `id` last; empty for an unknown id. */
  path: (id: string) => string[];
  /** Depth-first rows under and including `id`. */
  dfs: (id: string) => { node: NodeRec; depth: number }[];
  /** How many nodes are under `id`. */
  below: (id: string) => number;
  run: (id: string) => RunRec | undefined;
  answerOf: (id: string) => AnswerRec | undefined;
  comments: (node: string) => CommentRec[];
}

export function indexTree(tree: AskTree): TreeIndex {
  const nodes = new Map(tree.nodes.map((n) => [n.id, n]));
  const kids = new Map<string, NodeRec[]>();
  for (const n of tree.nodes) {
    const list = kids.get(n.par) ?? [];
    list.push(n);
    kids.set(n.par, list);
  }
  const index: TreeIndex = {
    nodes,
    kids: (id) => kids.get(id) ?? [],
    path: (id) => {
      const out: string[] = [];
      let at = nodes.get(id);
      while (at) {
        out.unshift(at.id);
        at = at.par === "r" ? undefined : nodes.get(at.par);
      }
      return out;
    },
    dfs: (id) => {
      const out: { node: NodeRec; depth: number }[] = [];
      const walk = (n: NodeRec, depth: number) => {
        out.push({ node: n, depth });
        for (const c of kids.get(n.id) ?? []) walk(c, depth + 1);
      };
      const start = nodes.get(id);
      if (start) walk(start, 0);
      return out;
    },
    below: (id) => {
      let count = 0;
      const walk = (x: string) => {
        for (const c of kids.get(x) ?? []) {
          count++;
          walk(c.id);
        }
      };
      walk(id);
      return count;
    },
    run: (id) => tree.runs[id],
    answerOf: (id) => tree.answers[id],
    comments: (node) => tree.comments.filter((c) => c.node === node),
  };
  return index;
}

/** A passage's tree: its top-level branches. `b` is the passage index;
 * branches asked from the footer (no `b`) go to the answer's last passage. */
export interface PassageTree {
  b: number;
  nodes: NodeRec[];
  /** Every branch in the tree, the top ones included. */
  total: number;
}

export function passageTrees(index: TreeIndex, passages: number): PassageTree[] {
  const by = new Map<number, NodeRec[]>();
  const last = Math.max(0, passages - 1);
  for (const n of index.kids("r")) {
    const b = n.b === null ? last : Math.min(n.b, last);
    const list = by.get(b) ?? [];
    list.push(n);
    by.set(b, list);
  }
  return [...by.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([b, nodes]) => ({
      b,
      nodes,
      total: nodes.reduce((sum, n) => sum + 1 + index.below(n.id), 0),
    }));
}

/** Whether anyone but `me` wrote under `id` (branches or comments): Delete
 * is then not offered (02 §4.2, the mock's `othersUnderBranch`). */
export function othersUnder(index: TreeIndex, id: string, me: string | null): boolean {
  const comments = index.comments(id);
  if (comments.some((c) => c.u !== me)) return true;
  return index.kids(id).some((c) => c.u !== me || othersUnder(index, c.id, me));
}

export const isActiveRun = (run: RunRec | undefined) =>
  run !== undefined && (run.status === "queued" || run.status === "running");
