import test from "ava";
import type { z } from "zod";

import {
  parsedResearchEventSchema,
  researchNodeSchema,
  researchNodeStatusSchema,
} from "../src/schemas/index.js";
import type {
  agentSpecSchema,
  recentResearchQuerySchema,
  researchDraftSchema,
  researchFolderStateSchema,
  researchHighlightFeedItemSchema,
  researchMessageAttachmentSchema,
  researchNodeContentSchema,
  researchRecapCandidateSchema,
  researchTreeDetailSchema,
  researchTreeSchema,
  researchTreeSummarySchema,
  runStateSchema,
  sessionEventSchema,
  turnSchema,
  updateResearchDocumentResultSchema,
  updateResearchPostResultSchema,
  userMessageSchema,
} from "../src/schemas/index.js";
import type {
  AgentSpec,
  ParsedResearchEvent,
  RecentResearchQuery,
  ResearchDraft,
  ResearchFolderState,
  ResearchHighlightFeedItem,
  ResearchMessageAttachment,
  ResearchNode,
  ResearchNodeContent,
  ResearchNodeStatus,
  ResearchRecapCandidate,
  ResearchTree,
  ResearchTreeDetail,
  ResearchTreeSummary,
  RunState,
  SessionEvent,
  Turn,
  UpdateResearchDocumentResult,
  UpdateResearchPostResult,
  UserMessage,
} from "../src/wire/index.js";

// A zod object's output marks an optional key `?: T | undefined`; a wire type
// writes it `?: T`, since JSON has no `undefined`. A `.loose()` schema's output
// also has a string index signature. `Defined` removes both differences so the
// comparison below checks only the named fields and their types.
type Defined<T> = T extends readonly (infer Item)[]
  ? Defined<Item>[]
  : T extends object
    ? {
        [Key in keyof T as string extends Key ? never : Key]: Defined<Exclude<T[Key], undefined>>;
      }
    : T;

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

type Conforms<Schema extends z.ZodType, Wire> = Same<Defined<z.output<Schema>>, Defined<Wire>>;

// Each entry is `true` only when the schema's output and the wire type agree,
// so a drift fails to compile.
const conformance: [
  Conforms<typeof researchNodeStatusSchema, ResearchNodeStatus>,
  Conforms<typeof researchMessageAttachmentSchema, ResearchMessageAttachment>,
  Conforms<typeof userMessageSchema, UserMessage>,
  Conforms<typeof agentSpecSchema, AgentSpec>,
  Conforms<typeof runStateSchema, RunState>,
  Conforms<typeof researchTreeSchema, ResearchTree>,
  Conforms<typeof researchNodeSchema, ResearchNode>,
  Conforms<typeof researchRecapCandidateSchema, ResearchRecapCandidate>,
  Conforms<typeof recentResearchQuerySchema, RecentResearchQuery>,
  Conforms<typeof researchFolderStateSchema, ResearchFolderState>,
  Conforms<typeof researchDraftSchema, ResearchDraft>,
  Conforms<typeof researchHighlightFeedItemSchema, ResearchHighlightFeedItem>,
  Conforms<typeof researchTreeSummarySchema, ResearchTreeSummary>,
  Conforms<typeof researchTreeDetailSchema, ResearchTreeDetail>,
  Conforms<typeof updateResearchDocumentResultSchema, UpdateResearchDocumentResult>,
  Conforms<typeof updateResearchPostResultSchema, UpdateResearchPostResult>,
  Conforms<typeof sessionEventSchema, SessionEvent>,
  Conforms<typeof parsedResearchEventSchema, ParsedResearchEvent>,
  Conforms<typeof turnSchema, Turn>,
  Conforms<typeof researchNodeContentSchema, ResearchNodeContent>,
] = [
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
];

test("every schema's output type matches its wire type", (t) => {
  t.true(conformance.every(Boolean));
});

const anchor = {
  version: 1,
  projection: "answer-v1",
  responseRevision: "a".repeat(64),
  start: 0,
  end: 5,
  exact: "hello",
  prefix: "",
  suffix: "",
} as const;

const exchange: ResearchNode = {
  id: "n1",
  treeId: "t1",
  parentNodeId: "n0",
  inline: false,
  anchor: { kind: "passage", anchor },
  title: null,
  groupId: "w1",
  createdAt: 1,
  highlights: [],
  type: "exchange",
  message: { text: "Why?" },
  agent: { adapter: "claude", model: "opus", effort: null },
  run: { status: "complete", startedAt: 1, completedAt: 2, sessionReady: true },
  recap: null,
};

const post: ResearchNode = {
  id: "p1",
  treeId: "t2",
  groupId: "w1",
  createdAt: 1,
  highlights: [],
  type: "post",
  message: { text: "https://example.com" },
  format: "link",
  followUpAgent: { adapter: "claude" },
};

const document: ResearchNode = {
  id: "d1",
  treeId: "t3",
  groupId: "w1",
  createdAt: 1,
  highlights: [],
  type: "document",
  source: "authored",
  editedAt: 3,
};

test("each node type parses back to the same value", (t) => {
  for (const node of [exchange, post, document]) {
    t.deepEqual(researchNodeSchema.parse(node), node);
  }
});

test("a node of an unknown type or with a reply anchor is rejected", (t) => {
  t.false(researchNodeSchema.safeParse({ ...post, type: "run" }).success);
  t.false(
    researchNodeSchema.safeParse({ ...exchange, anchor: { kind: "reply", replyId: "r1" } }).success,
  );
});

test("the status union is the desktop's with the web's interrupted", (t) => {
  t.deepEqual(researchNodeStatusSchema.options, [
    "queued",
    "starting",
    "running",
    "complete",
    "failed",
    "cancelled",
    "interrupted",
  ]);
});

test("research events parse by type", (t) => {
  const event = { type: "research.node.updated", node: exchange, timestamp: 5 };
  t.deepEqual(parsedResearchEventSchema.parse(event), event);
  t.false(parsedResearchEventSchema.safeParse({ type: "research.unknown", timestamp: 5 }).success);
});
