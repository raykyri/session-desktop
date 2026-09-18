import { canonicalTurnsJson, responseRevision } from "@session/shared";
import test from "ava";

import { revisionOf, snapshotByteSize } from "../src/index.js";

import { answerTurn } from "./helpers.js";

test("the synchronous revision matches the shared asynchronous one", async (t) => {
  const turns = [answerTurn("node-a", "An answer with a [[Term]] in it.")];
  t.is(revisionOf(turns), await responseRevision(turns));
});

test("the revision is 64 lowercase hex digits", (t) => {
  t.regex(revisionOf([answerTurn("node-a", "x")]), /^[0-9a-f]{64}$/);
});

test("key order does not change the revision", async (t) => {
  const left = [answerTurn("node-a", "same")];
  const right = [
    {
      sourceIndex: 0,
      blocks: [{ type: "text" as const, text: "same" }],
      role: "assistant",
      agentId: "node-a",
      id: "node-a-turn",
    },
  ];
  t.is(revisionOf(left), revisionOf(right));
  t.is(canonicalTurnsJson(left), canonicalTurnsJson(right));
  t.is(await responseRevision(right), revisionOf(left));
});

test("the byte size counts the stored JSON", (t) => {
  const turns = [answerTurn("node-a", "hello")];
  t.is(snapshotByteSize(turns), Buffer.byteLength(JSON.stringify(turns), "utf8"));
});
