import test from "ava";

import {
  collapseImageMarkers,
  imageMarkerSourcePath,
  splitImageMarkers,
} from "../src/markdown/imageMarkers.js";

const CACHE_MARKER =
  "[Image: source: /Users/raymond/.claude/image-cache/0da57d2c-6591-467c-8abf-6961554736e0/2.png]";
// The Session paste form: an absolute path with no "source:" prefix, the shape
// the composer writes and the reader renders as a thumbnail.
const PASTE_MARKER = "[Image: /Users/raymond/.claude/image-cache/session-paste-42-0.png]";
const CODEX_IMAGE_BLOCK =
  '<image name=[Image] path="/var/folders/example/T/codex-clipboard-BvUGfw.png">\n</image>';
const NUMBERED_CODEX_IMAGE_BLOCK =
  '<image name=[Image #1] path="/var/folders/example/T/codex-clipboard-numbered.png">\n</image>';

test("splitImageMarkers returns plain text untouched", (t) => {
  t.deepEqual(splitImageMarkers("fix the login bug"), [
    { kind: "text", text: "fix the login bug" },
  ]);
});

test("splitImageMarkers keeps empty text as a single text segment", (t) => {
  t.deepEqual(splitImageMarkers(""), [{ kind: "text", text: "" }]);
});

test("splitImageMarkers isolates a marker-only message", (t) => {
  t.deepEqual(splitImageMarkers(CACHE_MARKER), [{ kind: "image", text: CACHE_MARKER }]);
});

test("splitImageMarkers splits inline numbered references", (t) => {
  t.deepEqual(splitImageMarkers("fix this [Image #1] and this [Image #2]"), [
    { kind: "text", text: "fix this " },
    { kind: "image", text: "[Image #1]" },
    { kind: "text", text: " and this " },
    { kind: "image", text: "[Image #2]" },
  ]);
});

test("splitImageMarkers handles cache paths containing spaces", (t) => {
  const marker = "[Image: source: /Users/raymond/My Files/image cache/1.png]";
  t.deepEqual(splitImageMarkers(`look: ${marker}`), [
    { kind: "text", text: "look: " },
    { kind: "image", text: marker },
  ]);
});

test("splitImageMarkers does not match across lines or unclosed brackets", (t) => {
  const text = "[Image: source: /a\n/b] and [Image #x]";
  t.deepEqual(splitImageMarkers(text), [{ kind: "text", text }]);
});

test("splitImageMarkers handles adjacent markers", (t) => {
  t.deepEqual(splitImageMarkers(`${CACHE_MARKER}[Image #1]`), [
    { kind: "image", text: CACHE_MARKER },
    { kind: "image", text: "[Image #1]" },
  ]);
});

test("splitImageMarkers collapses a Codex clipboard image block", (t) => {
  t.deepEqual(splitImageMarkers(`inspect this:\n${CODEX_IMAGE_BLOCK}\nthanks`), [
    { kind: "text", text: "inspect this:\n" },
    { kind: "image", text: CODEX_IMAGE_BLOCK },
    { kind: "text", text: "\nthanks" },
  ]);
});

test("splitImageMarkers accepts quoted Codex image names and reordered attributes", (t) => {
  const marker = "<image path='/var/folders/example/image.png' name=\"[Image]\">\r\n  </image>";
  t.deepEqual(splitImageMarkers(marker), [{ kind: "image", text: marker }]);
});

test("splitImageMarkers accepts Codex's numbered clipboard image blocks", (t) => {
  t.deepEqual(splitImageMarkers(NUMBERED_CODEX_IMAGE_BLOCK), [
    { kind: "image", text: NUMBERED_CODEX_IMAGE_BLOCK },
  ]);
});

test("splitImageMarkers leaves non-empty or incomplete image tags visible", (t) => {
  const text =
    '<image name=[Image] path="/tmp/a.png">caption</image> <image name=[Image] path="/tmp/b.png">';
  t.deepEqual(splitImageMarkers(text), [{ kind: "text", text }]);
});

test("collapseImageMarkers replaces every marker shape with [Image]", (t) => {
  t.is(
    collapseImageMarkers(
      `before ${CACHE_MARKER} middle [Image #3] then ${CODEX_IMAGE_BLOCK} after`,
    ),
    "before [Image] middle [Image] then [Image] after",
  );
});

test("collapseImageMarkers leaves marker-free text unchanged", (t) => {
  t.is(collapseImageMarkers("nothing to see"), "nothing to see");
});

test("imageMarkerSourcePath extracts the cache path from a source marker", (t) => {
  t.is(
    imageMarkerSourcePath(CACHE_MARKER),
    "/Users/raymond/.claude/image-cache/0da57d2c-6591-467c-8abf-6961554736e0/2.png",
  );
});

test("imageMarkerSourcePath keeps interior spaces but trims edge whitespace", (t) => {
  t.is(
    imageMarkerSourcePath("[Image: source: /Users/raymond/My Files/image cache/1.png ]"),
    "/Users/raymond/My Files/image cache/1.png",
  );
});

test("imageMarkerSourcePath extracts paths from Codex image blocks", (t) => {
  t.is(
    imageMarkerSourcePath(CODEX_IMAGE_BLOCK),
    "/var/folders/example/T/codex-clipboard-BvUGfw.png",
  );
  t.is(
    imageMarkerSourcePath(NUMBERED_CODEX_IMAGE_BLOCK),
    "/var/folders/example/T/codex-clipboard-numbered.png",
  );
});

test("imageMarkerSourcePath returns null for pathless references and non-markers", (t) => {
  t.is(imageMarkerSourcePath("[Image #1]"), null);
  t.is(imageMarkerSourcePath("[Image: source: ]"), null);
  t.is(imageMarkerSourcePath("plain text"), null);
  t.is(imageMarkerSourcePath(`prefixed ${CACHE_MARKER}`), null);
});

test("splitImageMarkers isolates the session paste marker inline", (t) => {
  t.deepEqual(splitImageMarkers(`what is this? ${PASTE_MARKER}`), [
    { kind: "text", text: "what is this? " },
    { kind: "image", text: PASTE_MARKER },
  ]);
});

test("splitImageMarkers does not treat bracketed prose as a paste marker", (t) => {
  // Only a leading-slash absolute path qualifies, so "[Image: figure 2]" stays text.
  const text = "see [Image: figure 2] below";
  t.deepEqual(splitImageMarkers(text), [{ kind: "text", text }]);
});

test("imageMarkerSourcePath extracts the path from a session paste marker", (t) => {
  t.is(
    imageMarkerSourcePath(PASTE_MARKER),
    "/Users/raymond/.claude/image-cache/session-paste-42-0.png",
  );
});

test("collapseImageMarkers replaces the session paste marker too", (t) => {
  t.is(collapseImageMarkers(`look ${PASTE_MARKER} here`), "look [Image] here");
});
