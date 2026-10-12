//! Inline HTML widgets in research answers.
//!
//! A fenced code block whose info string starts with `session-html` defines a
//! widget. The answer text is the only durable copy. When the frontend displays
//! a block, it calls [`store`], which writes the block's HTML
//! to `<workspace>/.session/research-widgets/<sha256>.html` (idempotent, named
//! by the content hash), and receives two loopback URLs for it from
//! [`widget_urls`]. The file server renders either URL through the same page
//! wrapper and no-network policy as Codex visualization fragments:
//!
//! - the *static* URL serves the page under a CSP whose `script-src` permits
//!   only Session's height reporter and scroll bridge (by hash), so the
//!   browser renders the widget's markup and CSS without running its scripts;
//! - the *run* URL serves the same page with inline scripts allowed.
//!
//! Both tokens are random per process. The run token is unavailable to the
//! static page, so it cannot navigate to the run page (for example with
//! `<meta http-equiv="refresh">`). The reader must click Run.
//!
//! Widget scripts start only on that click. A sandboxed cross-origin iframe in
//! WKWebView can share the app's web content process, so a script that never
//! yields would block the entire interface.
//!
//! The run page exists only while [`scripts_allowed`]: on macOS, after the
//! native bridge has turned off WebRTC in the app web view (peer-connection
//! traffic is outside every CSP directive). Otherwise widgets stay static.

use pulldown_cmark::{CodeBlockKind, Event, Parser, Tag};
use sha2::{Digest, Sha256};
use std::borrow::Cow;
use std::fs;
use std::io::Write;
use std::ops::Range;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, Ordering};

/// The fenced code block language that marks a widget.
pub const FENCE_LANGUAGE: &str = "session-html";
/// Byte cap on one widget's HTML. Larger blocks display as code with a notice.
/// Mirrored by `MAX_SESSION_WIDGET_BYTES` in `src/lib/sessionWidgets.ts`.
pub const MAX_WIDGET_BYTES: usize = 64 * 1024;
/// URL path prefix the file server routes to [`resolve_request`].
pub const URL_PREFIX: &str = "/__session/widget/";
const WIDGET_DIR: &str = "research-widgets";

/// Instruction block given to research agents (Claude through
/// `--append-system-prompt`, Codex through `developer_instructions`, Grok
/// through `--rules`) while inline widgets are enabled. It depends only on
/// fenced code blocks, which every agent emits.
pub const AGENT_GUIDANCE: &str = r#"Session renders a fenced code block whose language is session-html as an interactive widget inside the answer.

Add a widget when the reader would understand the answer better by changing something and watching the result. Typical cases: how settings combine (layout rules, configuration options), how a quantity evolves over time or under adjustable parameters (a growth curve, a decay, a probability), how an algorithm proceeds step by step or behaves on different inputs, and how a mechanism responds to its input. In these cases add the widget even when a table of a few fixed cases also answers the literal question; a widget lets the reader try the cases the table leaves out. Do not add one when a sentence, list, table or mermaid diagram already makes the point, and never for decoration; factual answers, short how-tos, definitions and lists of sources need none. Use at most one widget per answer unless the question asks for more.

A widget is an HTML fragment that Session places inside the <body> of a sandboxed page:
- Self-contained: inline <style> and <script> only. Network requests and external resources (scripts, stylesheets, fonts, images, iframes) are blocked.
- Small: under 20 KB; the hard limit is 64 KB.
- Fills the width of the answer column; no fixed widths over 640 px. The frame's height follows the content, so do not size anything with vh units or height: 100%.
- Readable in light and dark mode: inherit the page's text color and background, or define colors for both with @media (prefers-color-scheme: dark).
- Session starts the widget's scripts only when the reader asks it to, so the HTML and CSS must show a meaningful initial state (default values, labels, a static figure) before any script runs.
- Optional saved inputs: window.sessionWidgetState.onRestore(value => { /* validate your versioned JSON state; null means defaults */ }) receives restored state. Call window.sessionWidgetState.save(value) after user input. Values must be JSON, at most 16 KiB; saving only persists when the reader opts in. Include a schema version and validate before applying restored inputs. New revisions start fresh unless the reader explicitly copies the parent state.
- The answer must be complete without the widget: state every conclusion in the prose; the widget illustrates it. Readers without widgets see the block as code, so do not mention Session's frame or how to start the widget.

Write the block as ```session-html, then the fragment, then ``` on its own line. Optional fence metadata: id="short-stable-id" title="Descriptive title" parent="64-character revision ID". When revising a selected artifact, keep its id and use the supplied revision hash as parent; never invent a parent hash. Legacy fences without metadata remain supported."#;

static SCRIPTS_ALLOWED: AtomicBool = AtomicBool::new(false);

/// Records whether widget scripts may run in this process: true only once the
/// app web view has WebRTC turned off (see `main.rs` startup).
pub fn set_scripts_allowed(allowed: bool) {
    SCRIPTS_ALLOWED.store(allowed, Ordering::SeqCst);
}

pub fn scripts_allowed() -> bool {
    SCRIPTS_ALLOWED.load(Ordering::SeqCst)
}

/// The guidance to send with a research launch, if widgets are enabled.
pub fn agent_guidance(enabled: bool) -> Option<&'static str> {
    enabled.then_some(AGENT_GUIDANCE)
}

/// Which page variant a widget URL selects.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WidgetMode {
    /// Markup and CSS only; Session's hashed scripts are the only ones allowed.
    Static,
    /// Inline scripts allowed.
    Run,
}

struct WidgetTokens {
    static_token: String,
    run_token: String,
}

fn random_hex_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes)
        .map_err(|err| format!("failed to generate a widget token: {err}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn tokens() -> Result<&'static WidgetTokens, String> {
    static TOKENS: OnceLock<Result<WidgetTokens, String>> = OnceLock::new();
    TOKENS
        .get_or_init(|| {
            Ok(WidgetTokens {
                static_token: random_hex_token()?,
                run_token: random_hex_token()?,
            })
        })
        .as_ref()
        .map_err(Clone::clone)
}

/// Directory holding stored widget pages for one Session workspace root.
pub fn widget_dir(workspace_root: &Path) -> PathBuf {
    workspace_root
        .join(crate::persistence::STATE_DIR)
        .join(WIDGET_DIR)
}

/// Lowercase hex SHA-256 of the widget's HTML; the stored file's name.
pub fn content_hash(html: &str) -> String {
    Sha256::digest(html.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn valid_hash(hash: &str) -> bool {
    hash.len() == 64
        && hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// Stores a widget's HTML under its content hash and returns the hash.
/// Storing the same HTML again rewrites nothing; a file whose bytes no longer
/// match its name is replaced.
pub fn store(workspace_root: &Path, html: &str) -> Result<String, String> {
    store_with_cap(workspace_root, html, MAX_STORE_BYTES)
}

fn store_with_cap(
    workspace_root: &Path,
    html: &str,
    max_store_bytes: u64,
) -> Result<String, String> {
    if html.len() > MAX_WIDGET_BYTES {
        return Err(format!(
            "widget is {} bytes; the limit is {MAX_WIDGET_BYTES}",
            html.len()
        ));
    }
    let hash = content_hash(html);
    let dir = widget_dir(workspace_root);
    let path = dir.join(format!("{hash}.html"));
    if fs::read(&path).is_ok_and(|existing| existing == html.as_bytes()) {
        // Refresh its modification time for eviction. Failure does not affect the result.
        let _ = fs::File::options()
            .write(true)
            .open(&path)
            .and_then(|file| file.set_modified(std::time::SystemTime::now()));
        return Ok(hash);
    }
    fs::create_dir_all(&dir).map_err(|err| format!("failed to create {}: {err}", dir.display()))?;
    let temporary = dir.join(format!(".{hash}.{}.tmp", random_hex_token()?));
    let written = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(&temporary)
        .and_then(|mut file| {
            file.write_all(html.as_bytes())?;
            file.sync_all()
        })
        .and_then(|()| fs::rename(&temporary, &path));
    if let Err(err) = written {
        let _ = fs::remove_file(&temporary);
        return Err(format!("failed to store widget {hash}: {err}"));
    }
    evict_least_recent(&dir, &path, max_store_bytes);
    Ok(hash)
}

/// Total size the widget store may reach before its least recently stored or
/// displayed pages are removed. Removal is always safe: a page is re-created
/// from the answer text the next time the widget is displayed.
const MAX_STORE_BYTES: u64 = 64 * 1024 * 1024;

/// Removes the least recently used widget pages (by modification time, which
/// [`store`] refreshes on reuse) until the store fits in `max_bytes`, never the
/// page just stored.
fn evict_least_recent(dir: &Path, keep: &Path, max_bytes: u64) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut pages: Vec<(std::time::SystemTime, u64, PathBuf)> = entries
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_name()
                .to_str()
                .and_then(|name| name.strip_suffix(".html"))
                .is_some_and(valid_hash)
        })
        .filter_map(|entry| {
            let meta = entry.metadata().ok()?;
            Some((meta.modified().ok()?, meta.len(), entry.path()))
        })
        .collect();
    let mut total: u64 = pages.iter().map(|(_, len, _)| len).sum();
    if total <= max_bytes {
        return;
    }
    pages.sort();
    for (_, len, path) in pages {
        if total <= max_bytes {
            break;
        }
        if path == keep {
            continue;
        }
        if fs::remove_file(&path).is_ok() {
            total = total.saturating_sub(len);
        }
    }
}

/// The loopback URLs for a stored widget. `run_url` is absent while widget
/// scripts are not allowed.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetUrls {
    pub static_url: String,
    pub run_url: Option<String>,
}

pub fn widget_urls(port: u16, hash: &str) -> Result<WidgetUrls, String> {
    widget_urls_with(port, hash, scripts_allowed())
}

fn widget_urls_with(port: u16, hash: &str, scripts_allowed: bool) -> Result<WidgetUrls, String> {
    if !valid_hash(hash) {
        return Err("invalid widget hash".to_string());
    }
    let tokens = tokens()?;
    let url = |token: &str| format!("http://127.0.0.1:{port}{URL_PREFIX}{token}/{hash}.html");
    Ok(WidgetUrls {
        static_url: url(&tokens.static_token),
        run_url: scripts_allowed.then(|| url(&tokens.run_token)),
    })
}

/// Resolves the part of a request path after [`URL_PREFIX`]
/// (`<token>/<hash>.html`) to a page mode and the stored file's path. Unknown
/// tokens and malformed names resolve to nothing, as does the run token while
/// scripts are not allowed; the file may not exist.
pub fn resolve_request(workspace_root: &Path, rest: &str) -> Option<(WidgetMode, PathBuf)> {
    resolve_request_with(workspace_root, rest, scripts_allowed())
}

fn resolve_request_with(
    workspace_root: &Path,
    rest: &str,
    scripts_allowed: bool,
) -> Option<(WidgetMode, PathBuf)> {
    let (token, file) = rest.split_once('/')?;
    let hash = file.strip_suffix(".html")?;
    if !valid_hash(hash) {
        return None;
    }
    let tokens = tokens().ok()?;
    let mode = if constant_time_eq(token, &tokens.static_token) {
        WidgetMode::Static
    } else if scripts_allowed && constant_time_eq(token, &tokens.run_token) {
        WidgetMode::Run
    } else {
        return None;
    };
    Some((
        mode,
        widget_dir(workspace_root).join(format!("{hash}.html")),
    ))
}

fn constant_time_eq(left: &str, right: &str) -> bool {
    left.len() == right.len()
        && left
            .bytes()
            .zip(right.bytes())
            .fold(0u8, |acc, (a, b)| acc | (a ^ b))
            == 0
}

/// Renames every `http-equiv` attribute in widget HTML to `data-http-equiv`,
/// ASCII case-insensitively, so a `<meta http-equiv="refresh">` cannot
/// navigate the frame without a click (sandboxed frames that allow scripts
/// also process automatic refreshes) and no other pragma applies. Attribute
/// names are not entity-decoded, so the literal spelling is the only form; a
/// mention of the word in text changes the same way but does not affect behavior.
/// Content-Security-Policy of a downloaded widget file: the static widget
/// page's policy without Session's script hashes, sandbox or file-server font
/// origin (a `<meta>` policy cannot sandbox). Mirrors
/// `SESSION_WIDGET_DOWNLOAD_POLICY` in web/packages/shared.
pub const DOWNLOAD_POLICY: &str = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

/// A downloaded widget file: the widget HTML, with `http-equiv` neutralised
/// as on the served pages, after a `<meta>` CSP carrying [`DOWNLOAD_POLICY`].
pub fn download_document(html: &str) -> String {
    format!(
        "<!doctype html>\n<html>\n<head>\n<meta charset=\"utf-8\">\n<meta http-equiv=\"Content-Security-Policy\" content=\"{DOWNLOAD_POLICY}\">\n</head>\n<body>\n{}\n</body>\n</html>\n",
        neutralize_http_equiv(html)
    )
}

pub fn neutralize_http_equiv(html: &str) -> Cow<'_, str> {
    const NAME: &[u8] = b"http-equiv";
    let bytes = html.as_bytes();
    let matches_at = |index: usize| {
        bytes.len() >= index + NAME.len()
            && bytes[index..index + NAME.len()].eq_ignore_ascii_case(NAME)
    };
    if !(0..bytes.len()).any(matches_at) {
        return Cow::Borrowed(html);
    }
    let mut out = String::with_capacity(html.len() + 16);
    let mut cursor = 0;
    let mut index = 0;
    while index < bytes.len() {
        if matches_at(index) {
            out.push_str(&html[cursor..index]);
            out.push_str("data-");
            out.push_str(&html[index..index + NAME.len()]);
            index += NAME.len();
            cursor = index;
        } else {
            index += 1;
        }
    }
    out.push_str(&html[cursor..]);
    Cow::Owned(out)
}

/// Whether a fenced code block's info string marks a widget.
pub fn is_widget_info(info: &str) -> bool {
    info.split_whitespace().next() == Some(FENCE_LANGUAGE)
}

/// Byte ranges of the widget blocks in `markdown`, each covering the fence
/// lines and the HTML between them. A block nested in a list or block quote
/// counts; text inside another code block does not.
pub fn widget_block_ranges(markdown: &str) -> Vec<Range<usize>> {
    let mut ranges = Vec::new();
    if !markdown.contains(FENCE_LANGUAGE) {
        return ranges;
    }
    for (event, range) in Parser::new(markdown).into_offset_iter() {
        if let Event::Start(Tag::CodeBlock(CodeBlockKind::Fenced(info))) = event
            && is_widget_info(&info)
        {
            ranges.push(range);
        }
    }
    ranges
}

/// `markdown` without its widget blocks, for derived text such as recap
/// sources and default titles. Every removed block leaves a blank line so the
/// surrounding paragraphs stay separate.
pub fn strip_widget_blocks(markdown: &str) -> Cow<'_, str> {
    let ranges = widget_block_ranges(markdown);
    if ranges.is_empty() {
        return Cow::Borrowed(markdown);
    }
    let mut out = String::with_capacity(markdown.len());
    let mut cursor = 0;
    for range in ranges {
        out.push_str(&markdown[cursor..range.start]);
        out.push_str("\n\n");
        cursor = range.end;
    }
    out.push_str(&markdown[cursor..]);
    Cow::Owned(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "session-widgets-{label}-{}-{}",
            std::process::id(),
            random_hex_token().unwrap()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn store_names_the_file_by_content_hash_and_is_idempotent() {
        let root = temp_root("store");
        let html = "<p>Widget</p>";
        let hash = store(&root, html).unwrap();
        assert_eq!(hash, content_hash(html));
        assert!(valid_hash(&hash));
        let path = widget_dir(&root).join(format!("{hash}.html"));
        assert_eq!(fs::read_to_string(&path).unwrap(), html);
        use std::os::unix::fs::MetadataExt;
        let inode = fs::metadata(&path).unwrap().ino();
        assert_eq!(store(&root, html).unwrap(), hash);
        // Not rewritten (a rewrite renames a new file into place).
        assert_eq!(fs::metadata(&path).unwrap().ino(), inode);
        // A file whose bytes no longer match its name is rewritten.
        fs::write(&path, "tampered").unwrap();
        assert_eq!(store(&root, html).unwrap(), hash);
        assert_eq!(fs::read_to_string(&path).unwrap(), html);
        // No temporary files remain.
        let names: Vec<_> = fs::read_dir(widget_dir(&root))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(names, vec![format!("{hash}.html")]);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn the_store_evicts_least_recently_used_pages_beyond_its_cap() {
        let root = temp_root("evict");
        let page = |n: usize| format!("<p>{n}</p>{}", "x".repeat(1000));
        let path = |html: &str| widget_dir(&root).join(format!("{}.html", content_hash(html)));
        let set_age = |html: &str, seconds_ago: u64| {
            let when = std::time::SystemTime::now() - std::time::Duration::from_secs(seconds_ago);
            fs::File::options()
                .write(true)
                .open(path(html))
                .unwrap()
                .set_modified(when)
                .unwrap();
        };
        for n in 0..3 {
            store_with_cap(&root, &page(n), 10_000).unwrap();
            set_age(&page(n), 300 - n as u64 * 100);
        }
        // Reusing page 0 marks it most recently used.
        store_with_cap(&root, &page(0), 10_000).unwrap();
        // A cap of three pages: storing a fourth removes the oldest, page 1.
        store_with_cap(&root, &page(3), 3 * 1010).unwrap();
        assert!(path(&page(0)).exists());
        assert!(!path(&page(1)).exists());
        assert!(path(&page(2)).exists());
        assert!(path(&page(3)).exists());
        // The page just stored survives even a cap smaller than itself.
        store_with_cap(&root, &page(4), 10).unwrap();
        assert!(path(&page(4)).exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn store_refuses_html_over_the_size_limit() {
        let root = temp_root("limit");
        let at_limit = "a".repeat(MAX_WIDGET_BYTES);
        assert!(store(&root, &at_limit).is_ok());
        let over = "a".repeat(MAX_WIDGET_BYTES + 1);
        let err = store(&root, &over).unwrap_err();
        assert!(err.contains("limit"), "{err}");
        assert!(
            !widget_dir(&root)
                .join(format!("{}.html", content_hash(&over)))
                .exists()
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn urls_resolve_to_their_mode_and_unknown_tokens_do_not() {
        let root = PathBuf::from("/workspace");
        let hash = content_hash("<p>x</p>");
        let urls = widget_urls_with(4100, &hash, true).unwrap();
        let run_url = urls.run_url.clone().unwrap();
        let rest = |url: &str| {
            url.strip_prefix(&format!("http://127.0.0.1:4100{URL_PREFIX}"))
                .unwrap()
                .to_string()
        };
        let expected = widget_dir(&root).join(format!("{hash}.html"));
        assert_eq!(
            resolve_request_with(&root, &rest(&urls.static_url), true),
            Some((WidgetMode::Static, expected.clone()))
        );
        assert_eq!(
            resolve_request_with(&root, &rest(&run_url), true),
            Some((WidgetMode::Run, expected.clone()))
        );
        assert_ne!(urls.static_url, run_url);
        // When scripts are disabled, no run URL is returned and the run token is rejected.
        assert_eq!(widget_urls_with(4100, &hash, false).unwrap().run_url, None);
        assert_eq!(resolve_request_with(&root, &rest(&run_url), false), None);
        assert_eq!(
            resolve_request_with(&root, &rest(&urls.static_url), false),
            Some((WidgetMode::Static, expected))
        );
        let bogus = format!("{}/{hash}.html", "0".repeat(64));
        assert_eq!(resolve_request_with(&root, &bogus, true), None);
        let token = rest(&run_url).split('/').next().unwrap().to_string();
        for name in [
            "../state.json".to_string(),
            format!("{}.html", &hash[..63]),
            format!("{}.html", hash.to_uppercase()),
            hash.clone(),
        ] {
            assert_eq!(
                resolve_request_with(&root, &format!("{token}/{name}"), true),
                None,
                "{name}"
            );
        }
        assert!(widget_urls(4100, "../x").is_err());
    }

    #[test]
    fn strips_widget_blocks_including_nested_ones_but_not_code_samples() {
        let markdown = "Intro.\n\n```session-html\n<p>one</p>\n```\n\nMiddle.\n\n- item\n\n  ~~~~session-html title\n  <p>two</p>\n  ~~~~\n\n> ```session-html\n> <p>three</p>\n> ```\n\n````markdown\n```session-html\n<p>sample</p>\n```\n````\n\nEnd.";
        let stripped = strip_widget_blocks(markdown);
        for gone in ["<p>one</p>", "<p>two</p>", "<p>three</p>"] {
            assert!(!stripped.contains(gone), "{stripped}");
        }
        for kept in ["Intro.", "Middle.", "- item", "<p>sample</p>", "End."] {
            assert!(stripped.contains(kept), "{stripped}");
        }
        assert!(matches!(
            strip_widget_blocks("No widgets."),
            Cow::Borrowed(_)
        ));
        // An unterminated block (a streaming answer) runs to the end.
        assert_eq!(
            strip_widget_blocks("Text.\n\n```session-html\n<p>par").trim(),
            "Text."
        );
        // A different language with the same prefix is not a widget.
        assert!(strip_widget_blocks("```session-htmlx\nkeep\n```").contains("keep"));
    }

    #[test]
    fn downloads_carry_the_static_policy_ahead_of_the_widget() {
        let file = download_document(
            "<meta HTTP-EQUIV=\"refresh\" content=\"0;url=https://bad.invalid\"><p>x</p>",
        );
        let policy =
            format!("<meta http-equiv=\"Content-Security-Policy\" content=\"{DOWNLOAD_POLICY}\">");
        assert!(file.find(&policy).unwrap() < file.find("<p>x</p>").unwrap());
        for directive in [
            "script-src 'none'",
            "connect-src 'none'",
            "default-src 'none'",
        ] {
            assert!(DOWNLOAD_POLICY.contains(directive));
        }
        assert!(
            !file
                .to_ascii_lowercase()
                .contains("<meta http-equiv=\"refresh\"")
        );
    }

    #[test]
    fn http_equiv_is_renamed_in_any_case() {
        assert_eq!(
            neutralize_http_equiv(
                r#"<meta HTTP-EQUIV="refresh" content="0;url=x"><meta http-equiv=refresh>"#
            ),
            r#"<meta data-HTTP-EQUIV="refresh" content="0;url=x"><meta data-http-equiv=refresh>"#
        );
        assert_eq!(
            neutralize_http_equiv("<meta/Http-Equiv=Refresh content=0>"),
            "<meta/data-Http-Equiv=Refresh content=0>"
        );
        assert!(matches!(
            neutralize_http_equiv("<p>plain</p>"),
            Cow::Borrowed(_)
        ));
        // Multi-byte text around a match stays intact.
        assert_eq!(
            neutralize_http_equiv("é http-equiv ü"),
            "é data-http-equiv ü"
        );
    }

    #[test]
    fn guidance_is_sent_only_when_enabled_and_names_the_fence() {
        assert_eq!(agent_guidance(false), None);
        let guidance = agent_guidance(true).unwrap();
        assert!(guidance.contains("```session-html"));
        assert!(guidance.contains("64 KB"));
        assert_eq!(MAX_WIDGET_BYTES, 64 * 1024);
    }
}
