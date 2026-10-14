use crate::events::SessionEvent;
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::VecDeque;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const MAX_TITLE_CHARS: usize = 120;
/// Title used when a request carries none.
const DEFAULT_TITLE: &str = "session";
const MAX_BODY_CHARS: usize = 4_096;
const MIN_TIMEOUT_MS: u64 = 1_000;
const MAX_TIMEOUT_MS: u64 = 30_000;
const DEFAULT_TIMEOUT_MS: u64 = 5_000;
const RATE_WINDOW: Duration = Duration::from_secs(10);
const RATE_LIMIT: usize = 10;

static RECENT_REQUESTS: LazyLock<Mutex<VecDeque<Instant>>> =
    LazyLock::new(|| Mutex::new(VecDeque::new()));

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum NotificationMode {
    Auto,
    /// Kept so older `session send --native` payloads still deserialize.
    /// Delivery is always the in-app overlay.
    Native,
    Overlay,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum NotificationTone {
    Info,
    Success,
    Warning,
    Error,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SendNotificationRequest {
    #[serde(default)]
    pub title: Option<String>,
    pub body: String,
    #[serde(default = "default_mode")]
    #[allow(dead_code)]
    pub mode: NotificationMode,
    #[serde(default = "default_tone")]
    pub tone: NotificationTone,
    #[serde(default)]
    pub sound: Option<bool>,
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn default_mode() -> NotificationMode {
    NotificationMode::Auto
}

fn default_tone() -> NotificationTone {
    NotificationTone::Info
}

fn default_timeout_ms() -> u64 {
    DEFAULT_TIMEOUT_MS
}

fn validate_text(
    value: &str,
    label: &str,
    max_chars: usize,
    allow_empty: bool,
) -> Result<(), String> {
    let count = value.chars().count();
    if !allow_empty && value.trim().is_empty() {
        return Err(format!("notification {label} must not be empty"));
    }
    if count > max_chars {
        return Err(format!(
            "notification {label} is too long ({count} characters; maximum {max_chars})"
        ));
    }
    if value.chars().any(|character| character == '\0') {
        return Err(format!(
            "notification {label} must not contain NUL characters"
        ));
    }
    Ok(())
}

fn validate_request(request: &SendNotificationRequest) -> Result<(), String> {
    validate_text(&request.body, "body", MAX_BODY_CHARS, false)?;
    if request
        .body
        .chars()
        .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
    {
        return Err("notification body contains unsupported control characters".to_string());
    }
    if let Some(title) = request.title.as_deref() {
        validate_text(title, "title", MAX_TITLE_CHARS, true)?;
        if title.chars().any(char::is_control) {
            return Err("notification title must be a single line".to_string());
        }
    }
    if !(MIN_TIMEOUT_MS..=MAX_TIMEOUT_MS).contains(&request.timeout_ms) {
        return Err(format!(
            "notification timeout must be between {} and {} seconds",
            MIN_TIMEOUT_MS / 1_000,
            MAX_TIMEOUT_MS / 1_000
        ));
    }
    Ok(())
}

fn check_rate_limit() -> Result<(), String> {
    let now = Instant::now();
    let mut recent = RECENT_REQUESTS
        .lock()
        .map_err(|_| "notification rate limiter lock poisoned".to_string())?;
    while recent
        .front()
        .is_some_and(|instant| now.duration_since(*instant) >= RATE_WINDOW)
    {
        recent.pop_front();
    }
    if recent.len() >= RATE_LIMIT {
        return Err("notification rate limit exceeded; try again in a few seconds".to_string());
    }
    recent.push_back(now);
    Ok(())
}

fn overlay_event(
    state: &AppState,
    id: &str,
    title: &str,
    created_at: i64,
    request: &SendNotificationRequest,
) {
    state.emit(SessionEvent::new(
        "app.notification_requested",
        None,
        None,
        json!({
            "id": id,
            "title": title,
            "body": request.body,
            "tone": request.tone,
            "sound": request.sound.unwrap_or(false),
            "timeoutMs": request.timeout_ms,
            "createdAt": created_at,
        }),
    ));
}

pub fn dispatch(
    state: &AppState,
    request: SendNotificationRequest,
) -> Result<serde_json::Value, String> {
    validate_request(&request)?;
    check_rate_limit()?;
    let title = request
        .title
        .clone()
        .filter(|title| !title.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_TITLE.to_string());

    let id = state.next_id("notification");
    let created_at = now_ms();
    overlay_event(state, &id, &title, created_at, &request);
    Ok(json!({ "accepted": true, "delivery": "overlay" }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_validation_rejects_empty_and_oversized_content() {
        let request = SendNotificationRequest {
            title: None,
            body: "  ".into(),
            mode: NotificationMode::Auto,
            tone: NotificationTone::Info,
            sound: None,
            timeout_ms: DEFAULT_TIMEOUT_MS,
        };
        assert!(
            validate_request(&request)
                .unwrap_err()
                .contains("must not be empty")
        );

        let request = SendNotificationRequest {
            body: "x".repeat(MAX_BODY_CHARS + 1),
            ..request
        };
        assert!(validate_request(&request).unwrap_err().contains("too long"));
    }

    #[test]
    fn request_validation_counts_characters_not_utf8_bytes() {
        let request = SendNotificationRequest {
            title: None,
            body: "🦀".repeat(MAX_BODY_CHARS),
            mode: NotificationMode::Overlay,
            tone: NotificationTone::Success,
            sound: Some(false),
            timeout_ms: MAX_TIMEOUT_MS,
        };
        assert!(validate_request(&request).is_ok());
    }

    #[test]
    fn request_validation_rejects_title_lines_and_body_controls() {
        let title_lines = SendNotificationRequest {
            title: Some("first\nsecond".into()),
            body: "body".into(),
            mode: NotificationMode::Overlay,
            tone: NotificationTone::Info,
            sound: None,
            timeout_ms: DEFAULT_TIMEOUT_MS,
        };
        assert!(
            validate_request(&title_lines)
                .unwrap_err()
                .contains("single line")
        );

        let body_control = SendNotificationRequest {
            title: None,
            body: "body\u{1b}[31m".into(),
            ..title_lines
        };
        assert!(
            validate_request(&body_control)
                .unwrap_err()
                .contains("control characters")
        );
    }
}
