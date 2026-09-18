// Link classification and safety for transcript markdown.
//
// Answer text is written by a model, so every destination it produces is
// untrusted input. Two questions are answered here, both purely from the href
// string: is this destination safe to navigate to, and does this inline code
// name a file the renderer should promote to an artifact link.
//
// The desktop's file-server machinery — loopback preview URLs, 64-hex path
// tokens, MIME allowlists, and resolution of a local path against a pane's cwd
// — is gone: the web has no local filesystem to serve and no panes to resolve
// against.

// Sentinel scheme for content that lives in the artifact store rather than at a
// URL. Agents still write `[preview](/Users/.../report.html)`-style absolute
// paths, and imported transcripts carry them; the renderer recognizes the
// scheme and hands the reference to the artifact resolver instead of treating
// it as a destination. It is never navigable, which is why `safeHref` rejects
// it along with every other non-web scheme.
export const SESSION_FILE_HREF_PREFIX = "session-file:";

export function isSessionFileHref(url: string): boolean {
  return url.startsWith(SESSION_FILE_HREF_PREFIX);
}

// Only let links through that the browser can safely navigate to. Transcript
// markdown can contain arbitrary agent text; a `javascript:` or `data:` URL
// clicked in the app runs in the app's own origin. Anything that is not
// http/https/mailto is rendered as non-navigable text.
export function safeHref(href: unknown): string | undefined {
  if (typeof href !== "string") {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(href, "https://session.invalid/");
  } catch {
    return undefined;
  }
  // Never expose the synthetic parsing origin as a real destination: every
  // relative href resolves against it, and none of them name a place the app
  // can go. Document-relative, site-relative, and fragment-only destinations
  // are all rejected here.
  if (url.hostname === "session.invalid") {
    return undefined;
  }
  // Return the resolved absolute URL, not the raw href: a protocol-relative
  // ("//host") href passes the protocol check once resolved against the base,
  // but handing the raw string downstream would let it resolve unpredictably.
  // Normalizing here means the link component always receives a fully
  // qualified http(s)/mailto URL.
  return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:"
    ? url.href
    : undefined;
}

// Portable path characters plus `/`. Spaces, URL punctuation, backslashes,
// Windows drive letters, and percent-encoding are all excluded so inline code
// like `const x = 1` or `https://example.com/a.html` never becomes a file link.
const INLINE_CODE_FILE_CHARS_PATTERN = /^[A-Za-z0-9._/-]+$/u;
const INLINE_CODE_FILE_EXTENSION_PATTERN = /\.(html|md)$/iu;
// Directory segments: `.`, `..`, a portable name, or a hidden directory
// (single leading dot). Dots inside a name are rejected so `example.com/a.html`
// cannot pass as a relative path.
const INLINE_CODE_DIR_SEGMENT_PATTERN = /^(?:\.\.?|\.?[A-Za-z0-9_-]+)$/u;
const INLINE_CODE_FILE_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+\.(html|md)$/iu;

/** Strict filename-like path for promoting transcript inline code to an
 * artifact link. Only `.html` / `.md` destinations; no spaces, URLs, or
 * characters outside a portable path subset. */
export function inlineCodeFilePath(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    return undefined;
  }
  if (!INLINE_CODE_FILE_CHARS_PATTERN.test(value) || value.includes("//")) {
    return undefined;
  }
  const extension = INLINE_CODE_FILE_EXTENSION_PATTERN.exec(value);
  const suffix = extension?.[0];
  if (!suffix) {
    return undefined;
  }
  const segments = value.split("/");
  const names = value.startsWith("/") ? segments.slice(1) : segments;
  if (names.length === 0 || names.some((segment) => segment.length === 0)) {
    return undefined;
  }
  const file = names[names.length - 1] ?? "";
  if (!INLINE_CODE_FILE_SEGMENT_PATTERN.test(file)) {
    return undefined;
  }
  const stem = file.slice(0, file.length - suffix.length);
  if (!/[A-Za-z0-9]/u.test(stem)) {
    return undefined;
  }
  for (const dir of names.slice(0, -1)) {
    if (!INLINE_CODE_DIR_SEGMENT_PATTERN.test(dir)) {
      return undefined;
    }
  }
  return value;
}
