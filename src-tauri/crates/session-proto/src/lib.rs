//! Wire types for Session's control protocol: newline-delimited JSON requests and
//! responses exchanged between the `session` CLI and the app's control listener.
//! Shared by the server (`control_socket`) and the client (`session-cli`) to keep
//! their definitions consistent.

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const TRANSCRIPT_STREAM_VERSION: &str = "4";
pub const REMOTE_OPEN_FILE_VERSION: &str = "1";
pub const WORKSPACE_OBSERVATION_VERSION: &str = "2";

/// A single control request. The server accepts only an empty `token` from a
/// same-user Unix-socket peer; `token` stays on the wire so a client from an
/// older build that still sends a pane token is refused rather than misparsed.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlRequest {
    pub token: String,
    pub command: String,
    #[serde(default)]
    pub payload: Value,
}

/// The server's reply to one `ControlRequest`.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlResponse {
    pub ok: bool,
    pub data: Value,
    pub error: Option<String>,
}

/// Extensions the embedded browser handles as a top-level local preview.
pub fn is_browser_preview_extension(extension: &str) -> bool {
    matches!(
        extension.to_ascii_lowercase().as_str(),
        "html"
            | "htm"
            | "css"
            | "js"
            | "mjs"
            | "json"
            | "svg"
            | "png"
            | "jpg"
            | "jpeg"
            | "gif"
            | "webp"
            | "avif"
            | "ico"
            | "pdf"
            | "mp4"
            | "webm"
            | "mp3"
            | "wav"
            | "txt"
            | "log"
            | "md"
            | "markdown"
            | "csv"
            | "xml"
            | "yaml"
            | "yml"
            | "toml"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_preview_extensions_are_explicit_and_case_insensitive() {
        assert!(is_browser_preview_extension("HTML"));
        assert!(is_browser_preview_extension("png"));
        assert!(is_browser_preview_extension("markdown"));
        assert!(!is_browser_preview_extension("zip"));
        assert!(!is_browser_preview_extension(""));
    }
}
