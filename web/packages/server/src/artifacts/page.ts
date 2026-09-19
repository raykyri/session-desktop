// The styled HTML page a Markdown or text document is rendered into
// (`11-artifacts-and-browser.md` §2).
//
// Ported from the desktop's `file_server.rs` (`MARKDOWN_PAGE_CSS:873`,
// `HTML_PREVIEW_SCROLL_SCRIPT:40`, `markdown_page_csp:680`) with two changes
// the web forces:
//
//   - the colors are the app's tokens (`packages/client/src/styles/tokens.css`,
//     green-blob) rather than the desktop's ad-hoc grays, so a preview matches
//     the stage it floats over;
//   - the Markdown is sanitized. The desktop let raw HTML through because the
//     overlay's opaque-origin sandbox contained it; here the iframe carries
//     `allow-same-origin` against the artifact host, so a `<script>` in an
// Sanitization provides defense-in-depth against script execution in uploaded markdown.

import { createHash } from "node:crypto";

import rehypeSanitize from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";

/**
 * Verbatim from `file_server.rs:40`. The panel restores scroll after a reload
 * from the `session-preview-scroll` messages this posts; it is the only script
 * the page CSP allows, and it is allowed by the hash of exactly these bytes, so
 * The CSP script-src hash must match PREVIEW_SCROLL_SCRIPT exactly or browser execution will be blocked.
 */
export const PREVIEW_SCROLL_SCRIPT =
  "(()=>{let f=0;addEventListener('scroll',()=>{cancelAnimationFrame(f);f=requestAnimationFrame(()=>parent.postMessage({type:'session-preview-scroll',x:scrollX,y:scrollY},'*'))},{passive:true});addEventListener('message',e=>{const d=e.data;if(d?.type!=='session-preview-scroll-restore'||!Number.isFinite(d.x)||!Number.isFinite(d.y))return;requestAnimationFrame(()=>requestAnimationFrame(()=>scrollTo(d.x,d.y)))})})();";

/** Base64 SHA-256 of the script above, computed at boot from the string that
 * is actually inlined — the hash and the body cannot drift apart. */
export const PREVIEW_SCROLL_SCRIPT_SHA256 = createHash("sha256")
  .update(PREVIEW_SCROLL_SCRIPT, "utf8")
  .digest("base64");

/** The `script-src` source expression for the inline bridge. */
export const PREVIEW_SCROLL_SCRIPT_CSP_SOURCE = `'sha256-${PREVIEW_SCROLL_SCRIPT_SHA256}'`;

/**
 * CSP for a rendered page: `default-src 'none'` with the scroll bridge allowed
 * by hash and nothing else executable. `font-src 'self'` is the artifact
 * origin's own `/__session/fonts/*.woff2`; `img-src` keeps embedded images
 * that resolve on this origin working and blocks every remote one.
 */
export function renderedPageContentSecurityPolicy(publicOrigin: string): string {
  return [
    "default-src 'none'",
    `script-src ${PREVIEW_SCROLL_SCRIPT_CSP_SOURCE}`,
    "style-src 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${publicOrigin}`,
  ].join("; ");
}

/**
 * The bridge that lets the panel recover from an expired or revoked token
 * (`11-artifacts-and-browser.md` §2, §3). Because cross-origin iframes cannot expose HTTP status codes, the error page posts its status via postMessage to prompt token re-minting. The status is read from the document rather
 * than interpolated, because the CSP allows this script by the hash of exactly
 * these bytes and an interpolated one would need a fresh hash per response.
 */
export const PREVIEW_ERROR_SCRIPT =
  "(()=>{const s=Number(document.documentElement.getAttribute('data-session-status'));parent.postMessage({type:'session-preview-error',status:s},'*')})();";

export const PREVIEW_ERROR_SCRIPT_SHA256 = createHash("sha256")
  .update(PREVIEW_ERROR_SCRIPT, "utf8")
  .digest("base64");

export const PREVIEW_ERROR_SCRIPT_CSP_SOURCE = `'sha256-${PREVIEW_ERROR_SCRIPT_SHA256}'`;

/** As the rendered-page policy, with the error bridge in place of the scroll
 * one and no fonts or images to load. */
export function errorPageContentSecurityPolicy(publicOrigin: string): string {
  return [
    "default-src 'none'",
    `script-src ${PREVIEW_ERROR_SCRIPT_CSP_SOURCE}`,
    "style-src 'unsafe-inline'",
    "connect-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${publicOrigin}`,
  ].join("; ");
}

/** The body faces served from this origin. `?session-body-font=` names one;
 * anything else falls back to the system stack, as on the desktop. */
export type BodyFontId = "dm-sans" | "inter" | "valley-sans";

export function parseBodyFont(value: string | null | undefined): BodyFontId | null {
  return value === "dm-sans" || value === "inter" || value === "valley-sans" ? value : null;
}

const SYSTEM_FONT_STACK =
  "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

/** `@font-face` blocks copied from `file_server.rs:900-927`, including the
 * unicode ranges that keep the Latin-Extended subset out of the common case. */
const DM_SANS_FONT_FACE_CSS =
  "@font-face { font-family: 'DM Sans'; src: url('/__session/fonts/DMSans-Variable-LatinExt.woff2') format('woff2'); font-style: normal; font-weight: 100 1000; font-display: swap; unicode-range: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF; }" +
  "@font-face { font-family: 'DM Sans'; src: url('/__session/fonts/DMSans-Variable-Latin.woff2') format('woff2'); font-style: normal; font-weight: 100 1000; font-display: swap; unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD; }" +
  "@font-face { font-family: 'DM Sans'; src: url('/__session/fonts/DMSans-VariableItalic-LatinExt.woff2') format('woff2'); font-style: italic; font-weight: 100 1000; font-display: swap; unicode-range: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF; }" +
  "@font-face { font-family: 'DM Sans'; src: url('/__session/fonts/DMSans-VariableItalic-Latin.woff2') format('woff2'); font-style: italic; font-weight: 100 1000; font-display: swap; unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD; }";

const INTER_FONT_FACE_CSS =
  "@font-face { font-family: 'Inter'; src: url('/__session/fonts/Inter-Variable-LatinExt.woff2') format('woff2'); font-style: normal; font-weight: 100 900; font-display: swap; unicode-range: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF; }" +
  "@font-face { font-family: 'Inter'; src: url('/__session/fonts/Inter-Variable-Latin.woff2') format('woff2'); font-style: normal; font-weight: 100 900; font-display: swap; unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD; }" +
  "@font-face { font-family: 'Inter'; src: url('/__session/fonts/Inter-VariableItalic-LatinExt.woff2') format('woff2'); font-style: italic; font-weight: 100 900; font-display: swap; unicode-range: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF; }" +
  "@font-face { font-family: 'Inter'; src: url('/__session/fonts/Inter-VariableItalic-Latin.woff2') format('woff2'); font-style: italic; font-weight: 100 900; font-display: swap; unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD; }";

const VALLEY_SANS_FONT_FACE_CSS =
  "@font-face { font-family: 'Valley Sans'; src: url('/__session/fonts/ValleySans-Variable.woff2') format('woff2'); font-style: normal; font-weight: 100 900; font-display: swap; }" +
  "@font-face { font-family: 'Valley Sans'; src: url('/__session/fonts/ValleySans-VariableItalic.woff2') format('woff2'); font-style: italic; font-weight: 100 900; font-display: swap; }";

function fontFaceCss(font: BodyFontId | null): string {
  if (font === "dm-sans") return DM_SANS_FONT_FACE_CSS;
  if (font === "inter") return INTER_FONT_FACE_CSS;
  return font === "valley-sans" ? VALLEY_SANS_FONT_FACE_CSS : "";
}

function bodyFontStack(font: BodyFontId | null): string {
  if (font === "dm-sans") return `'DM Sans', ${SYSTEM_FONT_STACK}`;
  if (font === "inter") return `'Inter', ${SYSTEM_FONT_STACK}`;
  return font === "valley-sans" ? `'Valley Sans', ${SYSTEM_FONT_STACK}` : SYSTEM_FONT_STACK;
}

/**
 * `MARKDOWN_PAGE_CSS` with the app's tokens. The values are the green-blob
 * theme's, light in `:root` and dark under `prefers-color-scheme`, because the
 * iframe cannot see the app's `data-appearance` attribute and a transparent
 * canvas would leave UA-default dark text on the app's own backdrop.
 */
const MARKDOWN_PAGE_CSS =
  "__SESSION_FONT_FACE__" +
  ":root { color-scheme: light dark;" +
  " --artifact-bg: #fbfcfb;" + // --right-pane-bg
  " --artifact-fg: #23282a;" + // --text-primary
  " --artifact-muted: #6b746f;" + // --text-muted
  " --artifact-accent: #1f8a6f;" + // --accent-color
  " --artifact-divider: #dde2df;" + // --surface-divider
  " --artifact-code-bg: #f3f5f4;" + // --transcript-code-bg
  " --artifact-table-border: #dfe4e2;" + // --markdown-table-border
  " --artifact-table-header-bg: #eaedec;" + // --pane-hover-bg
  " --artifact-quote-border: #c3ccc9; }" + // --markdown-blockquote-border
  "@media (prefers-color-scheme: dark) { :root {" +
  " --artifact-bg: #171b1d; --artifact-fg: #e7e7e2; --artifact-muted: #8a938e;" +
  " --artifact-accent: #8fd6c7; --artifact-divider: #2a2d2f; --artifact-code-bg: #111416;" +
  " --artifact-table-border: #262d2f; --artifact-table-header-bg: #1b1f21;" +
  " --artifact-quote-border: #3d4a4d; } }" +
  "body { margin: 0; font-family: __SESSION_BODY_FONT__; font-variant-ligatures: no-common-ligatures; line-height: 1.6; background: var(--artifact-bg); color: var(--artifact-fg); }" +
  "main { max-width: 48rem; margin: 0 auto; padding: 2rem 1.5rem 4rem; }" +
  "a { color: var(--artifact-accent); }" +
  "h1, h2 { border-bottom: 1px solid var(--artifact-divider); padding-bottom: 0.3em; }" +
  "code { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 0.9em; background: var(--artifact-code-bg); padding: 0.1em 0.3em; border-radius: 4px; }" +
  "pre { background: var(--artifact-code-bg); padding: 0.75rem 1rem; border-radius: 6px; overflow-x: auto; }" +
  "pre code { background: none; padding: 0; font-size: 0.85em; }" +
  "blockquote { margin-left: 0; padding-left: 1em; border-left: 3px solid var(--artifact-quote-border); color: var(--artifact-muted); }" +
  "table { border-collapse: collapse; display: block; overflow-x: auto; }" +
  "th, td { border: 1px solid var(--artifact-table-border); padding: 0.35em 0.7em; }" +
  "th { background: var(--artifact-table-header-bg); }" +
  "img { max-width: 100%; }" +
  "hr { border: none; border-top: 1px solid var(--artifact-divider); }" +
  "pre.session-source { white-space: pre-wrap; word-break: break-word; }";

export function pageCss(font: BodyFontId | null): string {
  return MARKDOWN_PAGE_CSS.replace("__SESSION_FONT_FACE__", fontFaceCss(font)).replace(
    "__SESSION_BODY_FONT__",
    bodyFontStack(font),
  );
}

/** Escapes text for interpolation into HTML (`file_server.rs:962`). */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  // `allowDangerousHtml` is deliberately absent: raw HTML in the source never
  // reaches the hast tree, so `<script>` is dropped before the sanitizer even
  // sees it and an `onerror` attribute has nothing to attach to.
  .use(remarkRehype)
  .use(rehypeSanitize)
  .use(rehypeStringify)
  .freeze();

/** Markdown to sanitized HTML. Everything in the pipeline is synchronous, so
 * the request handler does not have to await a render. */
export function renderMarkdown(source: string): string {
  return String(processor.processSync(source));
}

function page(title: string, body: string, font: BodyFontId | null): string {
  return (
    '<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    `<title>${escapeHtml(title)}</title>\n<style>${pageCss(font)}</style>\n</head>\n` +
    `<body>\n<main>\n${body}</main>\n<script>${PREVIEW_SCROLL_SCRIPT}</script>\n</body>\n</html>\n`
  );
}

export function renderMarkdownPage(title: string, source: string, font: BodyFontId | null): string {
  return page(title, renderMarkdown(source), font);
}

/** A plain-text document in the same shell: no Markdown is applied, because a
 * `.txt` or `.csv` that happens to start a line with `#` is not a heading. */
export function renderTextPage(title: string, source: string, font: BodyFontId | null): string {
  return page(title, `<pre class="session-source">${escapeHtml(source)}</pre>\n`, font);
}

/**
 * The body behind a 404 or 410 on `/a/:token`. Readable on its own when the
 * URL is opened in a tab, and self-announcing when it is framed.
 */
export function renderErrorPage(status: number, message: string): string {
  return (
    `<!doctype html>\n<html lang="en" data-session-status="${status}">\n<head>\n` +
    '<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    `<title>${escapeHtml(message)}</title>\n<style>${pageCss(null)}</style>\n</head>\n` +
    `<body>\n<main>\n<p>${escapeHtml(message)}</p>\n</main>\n` +
    `<script>${PREVIEW_ERROR_SCRIPT}</script>\n</body>\n</html>\n`
  );
}
