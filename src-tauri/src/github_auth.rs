//! GitHub sign-in via the OAuth device flow.
//!
//! The device flow needs only the public client id, so no client secret ships
//! with the app. The renderer never sees the device code or the access token:
//! `github_login_start` stores the pending device code here, the renderer polls
//! `github_login_poll` on the interval GitHub dictates, and on success the token
//! and resolved profile are written to the owner-only preferences file.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::Manager;

use crate::persistence;
use crate::state::AppState;

const DEVICE_CODE_URL: &str = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL: &str = "https://github.com/login/oauth/access_token";
const USER_URL: &str = "https://api.github.com/user";
const DEVICE_GRANT_TYPE: &str = "urn:ietf:params:oauth:grant-type:device_code";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
/// GitHub's minimum poll interval; `slow_down` asks for 5s more than the last one.
const SLOW_DOWN_BACKOFF_SECS: u64 = 5;

/// Profile fields persisted after sign-in. `id` is the stable identity; `login`
/// can be renamed by the user.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GithubAccount {
    pub id: u64,
    pub login: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub avatar_url: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GithubDeviceLogin {
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in_secs: u64,
    pub interval_secs: u64,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum GithubLoginPoll {
    /// Not approved yet; poll again after `interval_secs`.
    Pending {
        interval_secs: u64,
    },
    Complete {
        account: GithubAccount,
    },
    Expired,
    Denied,
}

struct PendingLogin {
    device_code: String,
    interval: Duration,
    expires_at: Instant,
}

static PENDING_LOGIN: Mutex<Option<PendingLogin>> = Mutex::new(None);

/// The OAuth app client id. Read from the process environment first (so `tauri dev`
/// can pick it up from a sourced `.env`), then from the build-time environment, which
/// `scripts/build.sh` populates from `.env`.
fn client_id() -> Result<String, String> {
    if let Ok(value) = std::env::var("GITHUB_CLIENT_ID")
        && !value.trim().is_empty()
    {
        return Ok(value.trim().to_string());
    }
    match option_env!("GITHUB_CLIENT_ID") {
        Some(value) if !value.trim().is_empty() => Ok(value.trim().to_string()),
        _ => Err(
            "GitHub sign-in is not configured: set GITHUB_CLIENT_ID in the environment or .env."
                .to_string(),
        ),
    }
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .user_agent("session")
        .build()
        .map_err(|err| format!("failed to build HTTP client: {err}"))
}

fn request_error(context: &str, err: reqwest::Error) -> String {
    if err.is_timeout() {
        format!("{context} timed out.")
    } else {
        format!("{context} failed: {err}")
    }
}

fn pending_login() -> std::sync::MutexGuard<'static, Option<PendingLogin>> {
    PENDING_LOGIN
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Outcome of one access-token poll, decoded from GitHub's JSON body.
#[derive(Debug, PartialEq, Eq)]
enum TokenPollOutcome {
    Pending,
    SlowDown,
    Expired,
    Denied,
    Token(String),
    Error(String),
}

fn classify_token_response(body: &Value) -> TokenPollOutcome {
    if let Some(token) = body.get("access_token").and_then(Value::as_str)
        && !token.is_empty()
    {
        return TokenPollOutcome::Token(token.to_string());
    }
    match body.get("error").and_then(Value::as_str) {
        Some("authorization_pending") => TokenPollOutcome::Pending,
        Some("slow_down") => TokenPollOutcome::SlowDown,
        Some("expired_token") => TokenPollOutcome::Expired,
        Some("access_denied") => TokenPollOutcome::Denied,
        Some(code) => {
            let description = body
                .get("error_description")
                .and_then(Value::as_str)
                .unwrap_or(code);
            TokenPollOutcome::Error(format!("GitHub sign-in failed: {description}"))
        }
        None => TokenPollOutcome::Error(
            "GitHub sign-in failed: unexpected response from GitHub.".to_string(),
        ),
    }
}

fn parse_account(body: &Value) -> Result<GithubAccount, String> {
    let id = body
        .get("id")
        .and_then(Value::as_u64)
        .ok_or_else(|| "GitHub profile response is missing an id.".to_string())?;
    let login = body
        .get("login")
        .and_then(Value::as_str)
        .filter(|login| !login.is_empty())
        .ok_or_else(|| "GitHub profile response is missing a login.".to_string())?;
    let avatar_url = body
        .get("avatar_url")
        .and_then(Value::as_str)
        .filter(|url| url.starts_with("https://"))
        .map(str::to_string)
        // Derivable from the id, so a missing field doesn't block sign-in.
        .unwrap_or_else(|| format!("https://avatars.githubusercontent.com/u/{id}?v=4"));
    let name = body
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string);
    Ok(GithubAccount {
        id,
        login: login.to_string(),
        name,
        avatar_url,
    })
}

async fn fetch_account(client: &reqwest::Client, token: &str) -> Result<GithubAccount, String> {
    let response = client
        .get(USER_URL)
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(|err| request_error("GitHub profile request", err))?;
    if !response.status().is_success() {
        return Err(format!(
            "GitHub profile request failed with status {}.",
            response.status().as_u16()
        ));
    }
    let body: Value = response
        .json()
        .await
        .map_err(|err| format!("failed to read GitHub profile response: {err}"))?;
    parse_account(&body)
}

fn workspace_root(app: &tauri::AppHandle) -> std::path::PathBuf {
    app.state::<AppState>().config().workspace_root.clone()
}

#[tauri::command(async)]
pub fn github_account_get(
    state: tauri::State<'_, AppState>,
) -> Result<Option<GithubAccount>, String> {
    Ok(persistence::load_preferences(&state.config().workspace_root)?.github_account)
}

/// Requests a device code and returns the user-facing code and verification URL.
/// Replaces any earlier pending login.
#[tauri::command]
pub async fn github_login_start() -> Result<GithubDeviceLogin, String> {
    let client_id = client_id()?;
    let client = http_client()?;
    let response = client
        .post(DEVICE_CODE_URL)
        .header("Accept", "application/json")
        .json(&serde_json::json!({ "client_id": client_id, "scope": "" }))
        .send()
        .await
        .map_err(|err| request_error("GitHub device code request", err))?;
    let status = response.status();
    let body: Value = response
        .json()
        .await
        .map_err(|err| format!("failed to read GitHub device code response: {err}"))?;
    if let Some(error) = body.get("error").and_then(Value::as_str) {
        let description = body
            .get("error_description")
            .and_then(Value::as_str)
            .unwrap_or(error);
        return Err(format!("GitHub sign-in failed: {description}"));
    }
    if !status.is_success() {
        return Err(format!(
            "GitHub device code request failed with status {}.",
            status.as_u16()
        ));
    }
    let device_code = body
        .get("device_code")
        .and_then(Value::as_str)
        .filter(|code| !code.is_empty())
        .ok_or_else(|| "GitHub device code response is missing a device code.".to_string())?
        .to_string();
    let user_code = body
        .get("user_code")
        .and_then(Value::as_str)
        .filter(|code| !code.is_empty())
        .ok_or_else(|| "GitHub device code response is missing a user code.".to_string())?
        .to_string();
    let verification_uri = body
        .get("verification_uri")
        .and_then(Value::as_str)
        .filter(|uri| uri.starts_with("https://"))
        .ok_or_else(|| "GitHub device code response is missing a verification URL.".to_string())?
        .to_string();
    let expires_in_secs = body
        .get("expires_in")
        .and_then(Value::as_u64)
        .unwrap_or(900);
    let interval_secs = body
        .get("interval")
        .and_then(Value::as_u64)
        .unwrap_or(5)
        .max(1);

    *pending_login() = Some(PendingLogin {
        device_code,
        interval: Duration::from_secs(interval_secs),
        expires_at: Instant::now() + Duration::from_secs(expires_in_secs),
    });
    Ok(GithubDeviceLogin {
        user_code,
        verification_uri,
        expires_in_secs,
        interval_secs,
    })
}

/// One access-token poll for the pending login. The renderer calls this on the
/// returned interval; GitHub's `slow_down` extends that interval.
#[tauri::command]
pub async fn github_login_poll(app: tauri::AppHandle) -> Result<GithubLoginPoll, String> {
    let (device_code, interval) = {
        let guard = pending_login();
        let pending = guard
            .as_ref()
            .ok_or_else(|| "No GitHub sign-in is in progress.".to_string())?;
        if Instant::now() >= pending.expires_at {
            drop(guard);
            *pending_login() = None;
            return Ok(GithubLoginPoll::Expired);
        }
        (pending.device_code.clone(), pending.interval)
    };
    let client_id = client_id()?;
    let client = http_client()?;
    let response = client
        .post(ACCESS_TOKEN_URL)
        .header("Accept", "application/json")
        .json(&serde_json::json!({
            "client_id": client_id,
            "device_code": device_code,
            "grant_type": DEVICE_GRANT_TYPE,
        }))
        .send()
        .await
        .map_err(|err| request_error("GitHub token request", err))?;
    let body: Value = response
        .json()
        .await
        .map_err(|err| format!("failed to read GitHub token response: {err}"))?;

    match classify_token_response(&body) {
        TokenPollOutcome::Pending => Ok(GithubLoginPoll::Pending {
            interval_secs: interval.as_secs(),
        }),
        TokenPollOutcome::SlowDown => {
            let next = interval + Duration::from_secs(SLOW_DOWN_BACKOFF_SECS);
            if let Some(pending) = pending_login().as_mut() {
                pending.interval = next;
            }
            Ok(GithubLoginPoll::Pending {
                interval_secs: next.as_secs(),
            })
        }
        TokenPollOutcome::Expired => {
            *pending_login() = None;
            Ok(GithubLoginPoll::Expired)
        }
        TokenPollOutcome::Denied => {
            *pending_login() = None;
            Ok(GithubLoginPoll::Denied)
        }
        TokenPollOutcome::Error(message) => {
            *pending_login() = None;
            Err(message)
        }
        TokenPollOutcome::Token(token) => {
            *pending_login() = None;
            let account = fetch_account(&client, &token).await?;
            let stored = account.clone();
            persistence::update_preferences(&workspace_root(&app), move |preferences| {
                preferences.github_token = Some(token);
                preferences.github_account = Some(stored);
            })?;
            Ok(GithubLoginPoll::Complete { account })
        }
    }
}

#[tauri::command]
pub fn github_login_cancel() {
    *pending_login() = None;
}

/// Forgets the stored token and profile. The grant stays listed under the user's
/// authorized GitHub apps until they revoke it there; revoking it here would need
/// the client secret.
#[tauri::command(async)]
pub fn github_logout(state: tauri::State<'_, AppState>) -> Result<(), String> {
    *pending_login() = None;
    persistence::update_preferences(&state.config().workspace_root, |preferences| {
        preferences.github_token = None;
        preferences.github_account = None;
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn token_response_maps_each_device_flow_state() {
        assert_eq!(
            classify_token_response(&json!({ "error": "authorization_pending" })),
            TokenPollOutcome::Pending
        );
        assert_eq!(
            classify_token_response(&json!({ "error": "slow_down", "interval": 10 })),
            TokenPollOutcome::SlowDown
        );
        assert_eq!(
            classify_token_response(&json!({ "error": "expired_token" })),
            TokenPollOutcome::Expired
        );
        assert_eq!(
            classify_token_response(&json!({ "error": "access_denied" })),
            TokenPollOutcome::Denied
        );
        assert_eq!(
            classify_token_response(&json!({
                "access_token": "gho_abc",
                "token_type": "bearer",
                "scope": ""
            })),
            TokenPollOutcome::Token("gho_abc".to_string())
        );
    }

    #[test]
    fn token_response_surfaces_unknown_errors_with_description() {
        assert_eq!(
            classify_token_response(&json!({
                "error": "device_flow_disabled",
                "error_description": "Device Flow must be explicitly enabled for this App"
            })),
            TokenPollOutcome::Error(
                "GitHub sign-in failed: Device Flow must be explicitly enabled for this App"
                    .to_string()
            )
        );
        assert!(matches!(
            classify_token_response(&json!({})),
            TokenPollOutcome::Error(_)
        ));
    }

    #[test]
    fn account_parses_profile_and_derives_missing_avatar() {
        let account = parse_account(&json!({
            "id": 1234,
            "login": "octocat",
            "name": "  The Octocat ",
            "avatar_url": "https://avatars.githubusercontent.com/u/1234?v=4"
        }))
        .unwrap();
        assert_eq!(
            account,
            GithubAccount {
                id: 1234,
                login: "octocat".to_string(),
                name: Some("The Octocat".to_string()),
                avatar_url: "https://avatars.githubusercontent.com/u/1234?v=4".to_string(),
            }
        );

        let bare = parse_account(&json!({ "id": 7, "login": "x", "name": null })).unwrap();
        assert_eq!(bare.name, None);
        assert_eq!(
            bare.avatar_url,
            "https://avatars.githubusercontent.com/u/7?v=4"
        );

        assert!(parse_account(&json!({ "login": "no-id" })).is_err());
        assert!(parse_account(&json!({ "id": 1 })).is_err());
    }

    #[test]
    fn login_poll_serializes_as_tagged_status() {
        let pending = serde_json::to_value(GithubLoginPoll::Pending { interval_secs: 5 }).unwrap();
        assert_eq!(pending, json!({ "status": "pending", "intervalSecs": 5 }));
        let expired = serde_json::to_value(GithubLoginPoll::Expired).unwrap();
        assert_eq!(expired, json!({ "status": "expired" }));
    }
}
