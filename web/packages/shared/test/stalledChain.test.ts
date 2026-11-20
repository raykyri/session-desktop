import test from "ava";

import { STALLED_TAIL_MESSAGES, stalledTailNote } from "../src/research/stalledChain.js";

const base = { readerIsPayer: false, readerIsOwner: false, payerIsOwner: false, payerName: "Ada" };

test("the person who pays for the stopped answer reads the desktop's sentence", (t) => {
  t.is(
    stalledTailNote({ ...base, status: "failed", readerIsPayer: true }),
    STALLED_TAIL_MESSAGES.failed,
  );
  t.is(
    stalledTailNote({ ...base, status: "stopped", readerIsPayer: true, readerIsOwner: true }),
    STALLED_TAIL_MESSAGES.stopped,
  );
});

test("anyone else is told who can retry it and what they can do", (t) => {
  t.is(
    stalledTailNote({ ...base, status: "failed" }),
    "The last answer stopped. Only Ada can retry it; the owner can delete it. Branch from the answer before it to continue.",
  );
  t.is(
    stalledTailNote({ ...base, status: "stopped", readerIsOwner: true }),
    "The last answer stopped. Only Ada can retry it. Delete it, or branch from the answer before it to continue.",
  );
  t.is(
    stalledTailNote({ ...base, status: "failed", payerIsOwner: true }),
    "The last answer stopped. Only Ada can retry or delete it. Branch from the answer before it to continue.",
  );
});
