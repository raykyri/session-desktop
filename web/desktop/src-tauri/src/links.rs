//! Links that leave the app. The web view opens no second window: a page
//! that asks for one (`window.open`, a link with `target="_blank"` the
//! opener plugin's click handler does not take) is refused, and an http or
//! https link it named opens in the system browser (review round 1 of
//! phase 3, finding 3). Wry answers no window by default, so without this
//! the request did nothing.

use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Runtime, Url};
use tauri_plugin_opener::OpenerExt;

/// Whether a new window's link opens in the browser: http and https only.
pub fn opens_in_browser(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
}

/// The answer to a page's request for a new window at `url`.
pub fn new_window<R: Runtime>(app: &AppHandle<R>, url: &Url) -> NewWindowResponse<R> {
    if opens_in_browser(url) {
        let _ = app.opener().open_url(url.as_str(), None::<&str>);
    }
    NewWindowResponse::Deny
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_http_and_https_open_in_the_browser() {
        for (u, yes) in [
            ("https://session.app/s/x", true),
            ("http://localhost:8960/", true),
            ("mailto:a@b.c", false),
            ("file:///etc/passwd", false),
            ("javascript:alert(1)", false),
            ("tauri://localhost/", false),
            ("smb://host/share", false),
        ] {
            assert_eq!(opens_in_browser(&Url::parse(u).unwrap()), yes, "{u}");
        }
    }
}
