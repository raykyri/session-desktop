// The feed's pure parts (02 §12.1): formatting, counts, the reply text,
// `lookPhrase`, the rail and pin geometry, the scroll offset, the effort
// step-down, the mention toast, reply rows, channel names, Browse's filter
// and the answer's rehype plugins.

import test from "ava";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";

import { placePins, railGeometry } from "../src/features/branches/geometry.js";
import { lookPhrase } from "../src/features/branches/lookPhrase.js";
import { browseList } from "../src/features/channels/BrowsePage.js";
import { NAME_ERROR, checkChannelName } from "../src/features/channels/NewChannelDialog.js";
import {
  clip,
  footerMeta,
  formatReply,
  ktok,
  plainReply,
  relTime,
  showsSaveCount,
} from "../src/features/feed/format.js";
import { rehypeCitations, rehypePassages } from "../src/features/markdown/answerPlugins.js";
import { replyRows } from "../src/features/replies/ReplyTree.js";
import { paddedScrollDelta } from "../src/lib/motion.js";
import { shortModelName, stepDownEffort } from "../src/replica/online.js";
import type { ChannelView } from "../src/replica/queries.js";
import { mentionToast } from "../src/replica/writes.js";

const NOW = Date.parse("2026-11-16T10:00:00Z");

test("relative times as the mock prints them", (t) => {
  t.is(relTime("2026-11-16T10:00:00Z", NOW), "now");
  t.is(relTime("2026-11-16T09:19:00Z", NOW), "41m");
  t.is(relTime("2026-11-16T07:00:00Z", NOW), "3h");
  t.is(relTime("2026-11-14T10:00:00Z", NOW), "2d");
  t.is(relTime("2026-10-26T10:00:00Z", NOW), "3w");
  t.is(relTime("2026-09-15T10:00:00Z", NOW), "2mo");
});

test("footer meta leaves out empty parts", (t) => {
  t.is(footerMeta(7, 184_000, "public"), "7 sources · 184k tokens · #public");
  t.is(footerMeta(2, 0, "ml"), "2 sources · #ml");
  t.is(footerMeta(0, 41_000, "ml"), "41k tokens · #ml");
  t.is(footerMeta(1, 900, "ml"), "1 source · 900 tokens · #ml");
  t.is(ktok(0), "");
});

test("no zero save count, and none below 3 in a private channel", (t) => {
  t.false(showsSaveCount(0, false));
  t.true(showsSaveCount(1, false));
  t.false(showsSaveCount(2, true));
  t.true(showsSaveCount(3, true));
});

test("clip ends on a word with an ellipsis", (t) => {
  t.is(clip("short", 10), "short");
  t.is(clip("one two three four", 12), "one two…");
});

test("reply text: quotes, and mentions of members only", (t) => {
  const parts = formatReply("> quoted line\nthanks @sol and @nobody", (h) => h === "sol");
  t.deepEqual(parts, [
    { kind: "quote", lines: [[{ text: "quoted line" }]] },
    {
      kind: "para",
      inline: [{ text: "thanks " }, { text: "@sol", mention: true }, { text: " and @nobody" }],
    },
  ]);
  t.is(plainReply("> quote\nanswer"), "answer");
});

test("lookPhrase: 1 to 4 whole words", (t) => {
  t.is(lookPhrase("Whuffie"), "Whuffie");
  t.is(lookPhrase("one two three four"), "one two three four");
  t.is(lookPhrase("one two three four five"), null);
  t.is(lookPhrase("“Delphi pools”,"), "Delphi pools");
  t.is(lookPhrase("Ålesund fjord"), "Ålesund fjord");
  t.is(lookPhrase("東京"), "東京");
  // a selection that starts or ends inside a word
  t.is(lookPhrase("uffie", { beforeStart: "h", atStart: "u", beforeEnd: "e", atEnd: "" }), null);
  t.is(lookPhrase("Whuff", { beforeStart: "", atStart: "W", beforeEnd: "f", atEnd: "i" }), null);
  t.is(
    lookPhrase("Whuffie", { beforeStart: " ", atStart: "W", beforeEnd: "e", atEnd: " " }),
    "Whuffie",
  );
});

test("the rail: a corner from the parent's dot into the child's, on the given first lines", (t) => {
  const { paths, dots } = railGeometry([
    { id: "a", parent: null, depth: 0, y: 13, on: true, selected: false },
    // a wrapped row: its dot stays at its first line's centre
    { id: "b", parent: "a", depth: 1, y: 43, on: true, selected: true },
    { id: "c", parent: null, depth: 0, y: 90, on: false, selected: false },
  ]);
  t.deepEqual(paths, [{ d: "M10 13 L10 37 Q10 43 16 43 L23 43", on: true }]);
  t.deepEqual(
    dots.map((d) => [d.cx, d.cy, d.state]),
    [
      [10, 13, "on"],
      [23, 43, "sel"],
      [10, 90, ""],
    ],
  );
});

test("pins sit at their anchors and stack 12 px apart when they overlap", (t) => {
  const { tops, height } = placePins([
    { anchor: 100, height: 50 },
    { anchor: 0, height: 40 },
    { anchor: 120, height: 30 },
  ]);
  t.deepEqual(tops, [100, 0, 162]);
  t.is(height, 162 + 30 + 12);
});

test("the padded scroll brings a composer in with 24 px below and 60 px above", (t) => {
  const box = { top: 0, bottom: 900 };
  t.is(paddedScrollDelta({ top: 850, bottom: 890 }, box), 14);
  t.is(paddedScrollDelta({ top: 30, bottom: 70 }, box), -30);
  t.is(paddedScrollDelta({ top: 300, bottom: 340 }, box), 0);
});

test("the effort steps down to the highest the model accepts", (t) => {
  t.is(stepDownEffort("max", ["low", "medium", "high"]), "high");
  t.is(stepDownEffort("xhigh", ["low", "medium", "high", "xhigh", "max"]), "xhigh");
  t.is(stepDownEffort("medium", ["low", "high"]), "low");
  t.is(shortModelName("Claude Fable 5.1"), "Fable");
  t.is(shortModelName("GPT-5.6 Luna"), "Luna");
  t.is(shortModelName("Gemini 3.8 Flash"), "Gemini");
});

test("the mention toast for a member, a non-member and both", (t) => {
  t.is(mentionToast({ notified: ["a"], notMembers: [] }), "Notified @a.");
  t.is(mentionToast({ notified: [], notMembers: ["c"] }), "@c isn't a member.");
  t.is(
    mentionToast({ notified: ["a", "b"], notMembers: ["c", "d"] }),
    "Notified @a, @b. @c, @d aren't members.",
  );
  t.is(mentionToast({ notified: [], notMembers: [] }), null);
});

test("reply rows: a collapsed reply counts what it hides", (t) => {
  const r = (id: string, parent: string | null) =>
    ({
      id,
      parent,
      u: "u",
      t: id,
      th: "t",
      s: "s",
      edited: false,
      del: false,
      mod: null,
      createdAt: "",
      rev: 1,
      kind: "reply",
    }) as const;
  const replies = [r("a", null), r("b", "a"), r("c", "a"), r("d", null)];
  t.deepEqual(
    replyRows(replies, []).map((x) => [x.reply.id, x.depth, x.hidden]),
    [
      ["a", 0, 0],
      ["b", 1, 0],
      ["c", 1, 0],
      ["d", 0, 0],
    ],
  );
  t.deepEqual(
    replyRows(replies, ["a"]).map((x) => [x.reply.id, x.hidden]),
    [
      ["a", 2],
      ["d", 0],
    ],
  );
});

test("channel names follow the shared validator", (t) => {
  t.deepEqual(checkChannelName("#Reading-Group "), { name: "reading-group", error: null });
  t.is(checkChannelName("a").error, NAME_ERROR);
  t.is(checkChannelName("-dash").error, NAME_ERROR);
  t.is(checkChannelName("x".repeat(31)).error, NAME_ERROR);
});

test("Browse lists open channels and the viewer's private ones, filtered", (t) => {
  const c = (name: string, over: Partial<ChannelView> = {}): ChannelView => ({
    id: name,
    name,
    desc: `About ${name}`,
    private: false,
    owner: "o",
    members: 1,
    frozen: false,
    joined: false,
    owned: false,
    ...over,
  });
  const all = [
    c("math"),
    c("secret", { private: true }),
    c("grants", { private: true, joined: true }),
  ];
  t.deepEqual(
    browseList(all, "").map((x) => x.name),
    ["math", "grants"],
  );
  t.deepEqual(
    browseList(all, "about gr").map((x) => x.name),
    ["grants"],
  );
  t.deepEqual(browseList(all, "zzz"), []);
});

interface Hast {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: Hast[];
}

/** Enough of hast-to-HTML for these assertions. */
function toHtml(node: Hast): string {
  if (node.type === "text") return node.value ?? "";
  const inner = (node.children ?? []).map(toHtml).join("");
  if (node.type !== "element") return inner;
  const attrs = Object.entries(node.properties ?? {})
    .map(([k, v]) => {
      const name = k === "className" ? "class" : k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
      return ` ${name}="${Array.isArray(v) ? v.join(" ") : String(v)}"`;
    })
    .join("");
  return `<${node.tagName}${attrs}>${inner}</${node.tagName}>`;
}

test("passages are numbered and a citation shares a nowrap span with its word", async (t) => {
  const processor = unified()
    .use(remarkParse)
    .use(remarkRehype)
    .use(rehypePassages)
    .use(rehypeCitations);
  const tree = await processor.run(
    processor.parse("First para ends here. [^2]\n\n#### Head\n\n- one\n- two *emph*[^1]\n\nLast."),
  );
  const html = toHtml(tree).replace(/\n/g, "");
  t.regex(
    html,
    /<p data-passage="0">First para ends <span class="nw">here\. <button[^>]*class="cite"[^>]*>2<\/button><\/span><\/p>/,
  );
  t.regex(html, /<h4 data-passage="1">Head<\/h4>/);
  t.regex(html, /<li data-passage="2">one<\/li>/);
  t.regex(html, /<li data-passage="3">two <span class="nw"><em>emph<\/em><button/);
  t.regex(html, /<p data-passage="4">Last\.<\/p>/);
});
