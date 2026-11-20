import test from "ava";

import { estimateTokenCount, formatEstimatedTokenCount } from "../src/util/tokenEstimate.js";

test("estimates ASCII text at roughly four characters per token", (t) => {
  t.is(estimateTokenCount(""), 0);
  t.is(estimateTokenCount("hello world!"), 3);
  t.is(estimateTokenCount("a".repeat(4_000)), 1_000);
});

test("weights non-ASCII text more heavily than ASCII text", (t) => {
  t.is(estimateTokenCount("abcd"), 1);
  t.is(estimateTokenCount("你好世界"), 4);
  t.is(estimateTokenCount("😀😀"), 2);
  t.is(estimateTokenCount("界".repeat(10_000)), 10_000);
});

test("formats estimates as compact token labels", (t) => {
  t.is(formatEstimatedTokenCount(""), "~0 tok");
  t.is(formatEstimatedTokenCount("a".repeat(4_000)), "~1.0k tok");
  t.is(formatEstimatedTokenCount("a".repeat(400_000)), "~100k tok");
});
