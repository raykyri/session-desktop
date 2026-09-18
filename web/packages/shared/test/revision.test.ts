import test from "ava";

import {
  canonicalTurnsJson,
  isResponseRevision,
  responseRevision,
} from "../src/research/revision.js";
import type { Turn, TurnBlock } from "../src/types/turn.js";
import { sha256Hex } from "../src/util/sha256.js";

function turn(role: string, blocks: TurnBlock[]): Turn {
  return { id: "t1", agentId: "node-1", role, blocks, sourceIndex: 0 };
}

const answer = [
  turn("user", [{ type: "text", text: "Why is the sky blue?" }]),
  turn("assistant", [
    { type: "toolUse", id: "call-1", name: "web_search", input: { query: "rayleigh" } },
    { type: "toolResult", toolUseId: "call-1", content: ["a result"], isError: false },
    { type: "text", text: "Rayleigh scattering." },
  ]),
];

test("canonical json sorts object keys at every depth", (t) => {
  t.is(
    canonicalTurnsJson([
      { sourceIndex: 0, role: "assistant", blocks: [], agentId: "node-1", id: "t1" },
    ]),
    '[{"agentId":"node-1","blocks":[],"id":"t1","role":"assistant","sourceIndex":0}]',
  );
  const nested = turn("assistant", [
    { type: "toolUse", name: "web_fetch", input: { url: "https://example.com", depth: 2 } },
  ]);
  t.regex(canonicalTurnsJson([nested]), /"input":\{"depth":2,"url":"https:\/\/example\.com"\}/);
});

test("key insertion order does not change the canonical json or the revision", async (t) => {
  const reordered: Turn[] = answer.map((source) => ({
    sourceIndex: source.sourceIndex,
    blocks: source.blocks,
    role: source.role,
    agentId: source.agentId,
    id: source.id,
  }));
  t.is(canonicalTurnsJson(reordered), canonicalTurnsJson(answer));
  t.is(await responseRevision(reordered), await responseRevision(answer));
});

test("undefined properties are omitted and null is kept", (t) => {
  const withUndefined: Turn = { ...turn("assistant", []), timestamp: undefined };
  const withNull: Turn = { ...turn("assistant", []), timestamp: null };
  t.false(canonicalTurnsJson([withUndefined]).includes("timestamp"));
  t.true(canonicalTurnsJson([withNull]).includes('"timestamp":null'));
  t.not(canonicalTurnsJson([withUndefined]), canonicalTurnsJson([withNull]));
});

test("array order is preserved and entries JSON cannot represent become null", (t) => {
  const blocks: TurnBlock[] = [
    { type: "raw", value: [1, undefined, "three"] },
    { type: "text", text: "after" },
  ];
  t.regex(canonicalTurnsJson([turn("assistant", blocks)]), /"value":\[1,null,"three"\]/);
  // A hole is not the same thing as an `undefined` entry, and only the hole
  // can turn the encoding into invalid JSON. Built by assignment rather than
  // `[1, , "three"]` so the gap survives lint.
  const sparse = [1];
  sparse[2] = 3;
  t.is(
    canonicalTurnsJson([turn("assistant", [{ type: "raw", value: sparse }])]).includes(",,"),
    false,
  );
  t.regex(
    canonicalTurnsJson([turn("assistant", [{ type: "raw", value: sparse }])]),
    /"value":\[1,null,3\]/,
  );
});

test("the revision is the sha256 of the canonical json", async (t) => {
  const revision = await responseRevision(answer);
  t.is(revision, await sha256Hex(canonicalTurnsJson(answer)));
  t.true(isResponseRevision(revision));
});

test("the revision is pinned for a fixed answer", async (t) => {
  t.is(
    await responseRevision(answer),
    "4c5469da87c42490a6db4d7bb4a05c83f6d9011aa4f9b9eca413dfeb759427e4",
  );
  t.is(await responseRevision([]), await sha256Hex("[]"));
});

test("a changed block changes the revision", async (t) => {
  const edited = answer.map((source) =>
    source.role === "assistant"
      ? turn("assistant", [{ type: "text", text: "Mie scattering." }])
      : source,
  );
  t.not(await responseRevision(edited), await responseRevision(answer));
});

test("only 64 lowercase hex digits read as a revision", (t) => {
  t.true(isResponseRevision("a".repeat(64)));
  t.false(isResponseRevision("A".repeat(64)));
  t.false(isResponseRevision("a".repeat(63)));
  t.false(isResponseRevision("a".repeat(65)));
  t.false(isResponseRevision(`${"a".repeat(63)}g`));
});
