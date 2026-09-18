import test from "ava";

import {
  inlineCodeFilePath,
  isSessionFileHref,
  safeHref,
  SESSION_FILE_HREF_PREFIX,
} from "../src/markdown/links.js";

test("safeHref keeps real http(s)/mailto URLs", (t) => {
  t.is(safeHref("https://example.com/a"), "https://example.com/a");
  t.is(safeHref("http://localhost:5173/"), "http://localhost:5173/");
  t.is(safeHref("mailto:hi@example.com"), "mailto:hi@example.com");
});

test("safeHref blocks javascript, data, and custom schemes", (t) => {
  t.is(safeHref("javascript:alert(1)"), undefined);
  t.is(safeHref("data:text/html,<script>alert(1)</script>"), undefined);
  t.is(safeHref("tauri://localhost/"), undefined);
  t.is(safeHref("asset://localhost/etc/passwd"), undefined);
});

test("safeHref rejects non-string hrefs", (t) => {
  t.is(safeHref(undefined), undefined);
  t.is(safeHref(42), undefined);
});

test("safeHref resolves a protocol-relative href before allowing it", (t) => {
  t.is(safeHref("//example.com/report.html"), "https://example.com/report.html");
});

// On the web an absolute filesystem path names nothing the browser can open,
// and file: URLs are not navigable from a page. Both are non-destinations
// rather than local previews, unlike the desktop, which minted a session-file:
// href and served the bytes over a loopback port.
test("safeHref rejects filesystem paths and file: URLs", (t) => {
  t.is(safeHref("/Users/raymond/Code/session/dev/report.html"), undefined);
  t.is(safeHref("file:///Users/raymond/report.html"), undefined);
  t.is(safeHref("C:\\work\\example.ts"), undefined);
});

test("safeHref rejects artifact references, which are resolved, not navigated", (t) => {
  t.is(safeHref(`${SESSION_FILE_HREF_PREFIX}dev/mock.html`), undefined);
  t.is(safeHref(`${SESSION_FILE_HREF_PREFIX}/tmp/example.html`), undefined);
});

test("safeHref rejects relative links that only resolve against the dummy base", (t) => {
  // /docs/intro has no real origin: resolving it against the dummy base would
  // make https://session.invalid/docs/intro, which is not a destination. The
  // same applies to document-relative and fragment-only hrefs.
  t.is(safeHref("/docs/intro"), undefined);
  t.is(safeHref("guide/intro"), undefined);
  t.is(safeHref("#details"), undefined);
});

test("safeHref does not alter web URL ports or punctuation", (t) => {
  t.is(safeHref("http://localhost:36"), "http://localhost:36/");
  t.is(safeHref("https://example.com/report.html."), "https://example.com/report.html.");
});

test("isSessionFileHref recognizes only the artifact scheme", (t) => {
  t.true(isSessionFileHref(`${SESSION_FILE_HREF_PREFIX}/Users/me/file.html`));
  t.true(isSessionFileHref(`${SESSION_FILE_HREF_PREFIX}dev/mock.html`));
  t.is(isSessionFileHref("https://example.com"), false);
  t.is(isSessionFileHref("/Users/me/file.html"), false);
});

test("inlineCodeFilePath accepts portable .html and .md paths", (t) => {
  t.is(inlineCodeFilePath("dev/mock.html"), "dev/mock.html");
  t.is(inlineCodeFilePath("docs/readme.md"), "docs/readme.md");
  t.is(inlineCodeFilePath("index.html"), "index.html");
  t.is(inlineCodeFilePath("README.md"), "README.md");
  t.is(inlineCodeFilePath("./dev/mock.html"), "./dev/mock.html");
  t.is(inlineCodeFilePath("../out/index.html"), "../out/index.html");
  t.is(inlineCodeFilePath("/tmp/preview.html"), "/tmp/preview.html");
  t.is(inlineCodeFilePath(".hidden.md"), ".hidden.md");
  t.is(inlineCodeFilePath("foo.bar.html"), "foo.bar.html");
  t.is(inlineCodeFilePath("path/to/file.HTML"), "path/to/file.HTML");
  t.is(inlineCodeFilePath(".config/notes.md"), ".config/notes.md");
});

test("inlineCodeFilePath rejects spaces, URLs, and non-filename text", (t) => {
  t.is(inlineCodeFilePath("foo bar.html"), undefined);
  t.is(inlineCodeFilePath("http://localhost/foo.html"), undefined);
  t.is(inlineCodeFilePath("https://example.com/foo.html"), undefined);
  t.is(inlineCodeFilePath("example.com/foo.html"), undefined);
  t.is(inlineCodeFilePath("//host/foo.html"), undefined);
  t.is(inlineCodeFilePath("foo.html?x=1"), undefined);
  t.is(inlineCodeFilePath("foo.html#bar"), undefined);
  t.is(inlineCodeFilePath("foo.ts"), undefined);
  t.is(inlineCodeFilePath("foo.mdx"), undefined);
  t.is(inlineCodeFilePath("foo.markdown"), undefined);
  t.is(inlineCodeFilePath("foo.htm"), undefined);
  t.is(inlineCodeFilePath(".html"), undefined);
  t.is(inlineCodeFilePath("foo/bar.ts"), undefined);
  t.is(inlineCodeFilePath("C:\\foo\\bar.html"), undefined);
  t.is(inlineCodeFilePath("foo\\bar.html"), undefined);
  t.is(inlineCodeFilePath(" foo.html"), undefined);
  t.is(inlineCodeFilePath("foo.html "), undefined);
  t.is(inlineCodeFilePath("open dev/mock.html"), undefined);
  t.is(inlineCodeFilePath("mailto:foo.md"), undefined);
  t.is(inlineCodeFilePath("foo$bar.html"), undefined);
  t.is(inlineCodeFilePath("@scope/file.html"), undefined);
  t.is(inlineCodeFilePath("foo%20bar.html"), undefined);
  t.is(inlineCodeFilePath("café.md"), undefined);
});
