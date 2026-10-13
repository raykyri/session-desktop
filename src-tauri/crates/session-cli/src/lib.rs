//! The Session command-line interface. The Session app binary doubles as the
//! CLI (the app's `main` dispatches through [`run_cli_if_requested`] before
//! starting Tauri); the standalone `session-cli` binary built from this crate
//! provides the same commands without the app.
//!
//! Commands: `send` posts a notification to the running app, `ping` checks that
//! the app's control socket answers, and `--version` prints the CLI version.
//! Both socket commands use the token-free, same-user-peer path of the control
//! socket.

use serde_json::{Value, json};
use session_proto::{ControlRequest, ControlResponse};
use std::env;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::time::Duration;

const USAGE: &str = "usage: session <send|ping|--version>";

const SYNTAX_ERROR_PREFIX: &str = "\u{1d}session-syntax:";

fn syntax_error(message: String) -> String {
    format!("{SYNTAX_ERROR_PREFIX}{message}")
}

pub fn error_report(error: &str) -> (&str, i32) {
    if let Some(message) = error.strip_prefix(SYNTAX_ERROR_PREFIX) {
        (message, 2)
    } else if error.starts_with("usage:") {
        (error, 2)
    } else {
        (error, 1)
    }
}

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

pub fn version_line() -> String {
    format!("session-cli {VERSION}")
}

/// Parses `session-cli 0.3.2` (and trailing noise) into the version token.
pub fn parse_version_line(line: &str) -> Option<&str> {
    line.trim()
        .strip_prefix("session-cli ")?
        .split_whitespace()
        .next()
}

pub fn run_cli_if_requested() -> Result<bool, String> {
    let mut args = env::args().skip(1);
    let Some(command) = args.next() else {
        return Ok(false);
    };
    let remaining = args.collect::<Vec<_>>();
    match command.as_str() {
        "--version" | "-V" => {
            println!("{}", version_line());
            Ok(true)
        }
        "send" => {
            run_notification_send(remaining)?;
            Ok(true)
        }
        "ping" => {
            if !remaining.is_empty() {
                return Err(syntax_error("usage: session ping".to_string()));
            }
            run_ping()?;
            Ok(true)
        }
        "help" | "--help" | "-h" => {
            println!("{USAGE}");
            Ok(true)
        }
        _ => Ok(false),
    }
}

/// Asks the running app's control socket for a liveness reply.
fn run_ping() -> Result<(), String> {
    let socket_path = notification_socket_path()?;
    let raw = send_request_with_timeout(
        socket_path.to_string_lossy().as_ref(),
        "",
        "ping",
        json!({}),
        Duration::from_secs(2),
    )?;
    let response = serde_json::from_str::<ControlResponse>(&raw)
        .map_err(|error| format!("invalid Session response: {error}"))?;
    if response.ok {
        println!("{}", response.data);
        Ok(())
    } else {
        Err(response
            .error
            .unwrap_or_else(|| "Session did not answer the ping".to_string()))
    }
}

const SEND_USAGE: &str = "usage: session send [--title <text>] [--mode <auto|overlay>] [--tone <info|success|warning|error>] [--sound|--no-sound] [--timeout <seconds>] [--stdin] [--] <message>";

#[derive(Debug, PartialEq)]
struct NotificationSendArgs {
    title: Option<String>,
    body: String,
    mode: String,
    tone: String,
    sound: Option<bool>,
    timeout_ms: u64,
}

fn run_notification_send(args: Vec<String>) -> Result<(), String> {
    if args.as_slice() == ["--help"] || args.as_slice() == ["-h"] {
        println!("{SEND_USAGE}");
        return Ok(());
    }
    let parsed = parse_notification_send(args, || {
        let mut input = String::new();
        std::io::stdin()
            .read_to_string(&mut input)
            .map_err(|error| format!("failed to read notification body from stdin: {error}"))?;
        Ok(input.trim_end_matches(['\r', '\n']).to_string())
    })
    .map_err(syntax_error)?;
    let socket_path = notification_socket_path()?;
    // The empty token selects the control socket's same-user-peer path.
    let raw = send_request_with_timeout(
        socket_path.to_string_lossy().as_ref(),
        "",
        "notification.send",
        json!({
            "title": parsed.title,
            "body": parsed.body,
            "mode": parsed.mode,
            "tone": parsed.tone,
            "sound": parsed.sound,
            "timeoutMs": parsed.timeout_ms,
        }),
        Duration::from_secs(2),
    )?;
    let response = serde_json::from_str::<ControlResponse>(&raw)
        .map_err(|error| format!("invalid Session response: {error}"))?;
    if response.ok {
        Ok(())
    } else {
        Err(response
            .error
            .unwrap_or_else(|| "Session rejected the notification".to_string()))
    }
}

fn parse_notification_send(
    mut args: Vec<String>,
    read_stdin: impl FnOnce() -> Result<String, String>,
) -> Result<NotificationSendArgs, String> {
    let mut title = None;
    let mut mode = "auto".to_string();
    let mut tone = "info".to_string();
    let mut sound = None;
    let mut timeout_ms = 5_000_u64;
    let mut stdin = false;
    let mut message = Vec::new();
    let mut options = true;

    while !args.is_empty() {
        let argument = args.remove(0);
        if options && argument == "--" {
            options = false;
            continue;
        }
        if !options || !argument.starts_with('-') || argument == "-" {
            message.push(argument);
            continue;
        }
        match argument.as_str() {
            "--title" => title = Some(take_send_value(&mut args, &argument)?),
            "--mode" => {
                let value = take_send_value(&mut args, &argument)?;
                if !matches!(value.as_str(), "auto" | "overlay") {
                    return Err(format!(
                        "invalid notification mode {value:?}; expected auto or overlay"
                    ));
                }
                mode = value;
            }
            "--auto" => mode = "auto".to_string(),
            "--overlay" => mode = "overlay".to_string(),
            "--tone" => {
                let value = take_send_value(&mut args, &argument)?;
                if !matches!(value.as_str(), "info" | "success" | "warning" | "error") {
                    return Err(format!(
                        "invalid notification tone {value:?}; expected info, success, warning, or error"
                    ));
                }
                tone = value;
            }
            "--sound" => sound = Some(true),
            "--no-sound" => sound = Some(false),
            "--timeout" => {
                let value = take_send_value(&mut args, &argument)?;
                let seconds = value.parse::<u64>().map_err(|_| {
                    format!("invalid notification timeout {value:?}; expected whole seconds")
                })?;
                if !(1..=30).contains(&seconds) {
                    return Err("notification timeout must be between 1 and 30 seconds".to_string());
                }
                timeout_ms = seconds * 1_000;
            }
            "--stdin" => stdin = true,
            "--help" | "-h" => return Err(SEND_USAGE.to_string()),
            _ => return Err(format!("unknown session send option {argument:?}")),
        }
    }

    if stdin && !message.is_empty() {
        return Err("session send accepts either --stdin or a message, not both".to_string());
    }
    let body = if stdin {
        read_stdin()?
    } else {
        message.join(" ")
    };
    if body.trim().is_empty() {
        return Err(SEND_USAGE.to_string());
    }
    Ok(NotificationSendArgs {
        title,
        body,
        mode,
        tone,
        sound,
        timeout_ms,
    })
}

fn take_send_value(args: &mut Vec<String>, flag: &str) -> Result<String, String> {
    if args.is_empty() {
        return Err(format!("{flag} requires a value"));
    }
    Ok(args.remove(0))
}

fn notification_socket_path() -> Result<PathBuf, String> {
    if let Some(path) = env::var_os("SESSION_SOCK").filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(path));
    }
    if let Some(path) = configured_notification_socket_path()? {
        return Ok(path);
    }
    dirs::runtime_dir()
        .map(|root| root.join("session").join("session.sock"))
        .or_else(|| {
            dirs::data_dir().map(|root| root.join("session").join("run").join("session.sock"))
        })
        .ok_or_else(|| {
            "could not locate Session's control socket; set SESSION_SOCK explicitly".to_string()
        })
}

fn configured_notification_socket_path() -> Result<Option<PathBuf>, String> {
    let cwd = env::current_dir().map_err(|error| format!("failed to read cwd: {error}"))?;
    let explicit = env::var_os("SESSION_CONFIG").filter(|value| !value.is_empty());
    let config_path = if let Some(path) = explicit.as_ref() {
        let path = PathBuf::from(path);
        Some(if path.is_absolute() {
            path
        } else {
            cwd.join(path)
        })
    } else if cfg!(debug_assertions) {
        let path = cwd.join("session.config.json");
        path.exists().then_some(path)
    } else {
        None
    };
    let Some(config_path) = config_path else {
        return Ok(None);
    };
    let raw = std::fs::read_to_string(&config_path).map_err(|error| {
        format!(
            "failed to read Session config {}: {error}",
            config_path.display()
        )
    })?;
    let config = serde_json::from_str::<Value>(&raw).map_err(|error| {
        format!(
            "failed to parse Session config {}: {error}",
            config_path.display()
        )
    })?;
    let configured = config
        .get("socketPath")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            format!(
                "Session config {} has no string socketPath",
                config_path.display()
            )
        })?;
    let config_dir = config_path.parent().unwrap_or(&cwd);
    Ok(Some(resolve_notification_socket_path(
        config_dir,
        Path::new(configured),
        env::var_os("HOME")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .as_deref(),
    )))
}

fn resolve_notification_socket_path(
    config_dir: &Path,
    configured: &Path,
    home: Option<&Path>,
) -> PathBuf {
    if let Some(home) = home
        && let Ok(suffix) = configured.strip_prefix("~")
    {
        return home.join(suffix);
    }
    if configured.is_absolute() {
        return configured.to_path_buf();
    }
    if home.is_some_and(|home| config_dir.starts_with(home)) {
        return config_dir.join(configured);
    }
    dirs::runtime_dir()
        .map(|root| root.join("session").join("session.sock"))
        .or_else(|| {
            dirs::data_dir().map(|root| root.join("session").join("run").join("session.sock"))
        })
        .unwrap_or_else(|| config_dir.join(configured))
}

fn send_request_with_timeout(
    socket_path: &str,
    token: &str,
    command: &str,
    payload: Value,
    timeout: Duration,
) -> Result<String, String> {
    let token = token.to_string();
    let mut stream = UnixStream::connect(socket_path)
        .map_err(|err| format!("failed to connect to {socket_path}: {err}"))?;
    let timeout = Some(timeout);
    let _ = stream.set_read_timeout(timeout);
    let _ = stream.set_write_timeout(timeout);
    let request = ControlRequest {
        token,
        command: command.to_string(),
        payload,
    };

    serde_json::to_writer(&mut stream, &request)
        .map_err(|err| format!("failed to encode request: {err}"))?;
    stream
        .write_all(b"\n")
        .map_err(|err| format!("failed to send request: {err}"))?;
    stream
        .flush()
        .map_err(|err| format!("failed to flush request: {err}"))?;

    let mut response = String::new();
    BufReader::new(stream)
        .read_line(&mut response)
        .map_err(|err| format!("failed to read response: {err}"))?;
    Ok(response.trim_end().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_line_matches_package_and_parses() {
        let line = version_line();
        assert_eq!(line, format!("session-cli {VERSION}"));
        assert_eq!(parse_version_line(&line), Some(VERSION));
        assert_eq!(parse_version_line("session-cli 0.3.2\n"), Some("0.3.2"));
        assert_eq!(parse_version_line("not-a-version"), None);
        // A matching version string alone does not mean an old helper binary supports SESSION_* env vars.
        assert_eq!(parse_version_line(&format!("qmux-cli {VERSION}")), None);
    }

    #[test]
    fn notification_send_parser_preserves_explicit_message_options() {
        let parsed = parse_notification_send(
            vec![
                "--title".into(),
                "Tests".into(),
                "--overlay".into(),
                "--tone".into(),
                "success".into(),
                "--no-sound".into(),
                "--timeout".into(),
                "12".into(),
                "--".into(),
                "-all".into(),
                "passed".into(),
            ],
            || panic!("stdin must not be read without --stdin"),
        )
        .unwrap();
        assert_eq!(
            parsed,
            NotificationSendArgs {
                title: Some("Tests".into()),
                body: "-all passed".into(),
                mode: "overlay".into(),
                tone: "success".into(),
                sound: Some(false),
                timeout_ms: 12_000,
            }
        );
    }

    #[test]
    fn notification_send_reads_stdin_only_when_requested() {
        let parsed =
            parse_notification_send(vec!["--stdin".into()], || Ok("hello\n".into())).unwrap();
        assert_eq!(parsed.body, "hello\n");

        let error =
            parse_notification_send(vec!["--stdin".into(), "also-an-argument".into()], || {
                Ok("stdin".into())
            })
            .unwrap_err();
        assert!(error.contains("either --stdin or a message"));
    }

    #[test]
    fn notification_send_rejects_invalid_enums_and_timeouts() {
        assert!(
            parse_notification_send(
                vec!["--mode".into(), "carrier-pigeon".into(), "hello".into()],
                || unreachable!(),
            )
            .unwrap_err()
            .contains("invalid notification mode")
        );
        assert!(
            parse_notification_send(
                vec!["--timeout".into(), "31".into(), "hello".into()],
                || unreachable!(),
            )
            .unwrap_err()
            .contains("between 1 and 30")
        );
    }

    #[test]
    fn notification_socket_config_expands_home_and_relative_paths() {
        let home = Path::new("/tmp/session-cli-home");
        assert_eq!(
            resolve_notification_socket_path(
                Path::new("/tmp/session-cli-home/config"),
                Path::new("~/run/session.sock"),
                Some(home),
            ),
            PathBuf::from("/tmp/session-cli-home/run/session.sock")
        );
        assert_eq!(
            resolve_notification_socket_path(
                Path::new("/tmp/session-cli-home/config"),
                Path::new("run/session.sock"),
                Some(home),
            ),
            PathBuf::from("/tmp/session-cli-home/config/run/session.sock")
        );
    }
}
