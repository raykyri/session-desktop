//! Installs a matching standalone `session-cli` onto a remote host.
//!
//! Local Session uses the app binary as the CLI. A remote pane needs the
//! linux-musl artifact bundled in the app, pushed over the same BatchMode SSH
//! path that provisions support files.

use crate::host::{Host, RemoteCommand};
use crate::persistence;
use crate::pty;
use crate::state::AppState;
use crate::workspace::RemoteRef;
use session_cli::{VERSION, parse_version_line};
use session_proto::{
    REMOTE_OPEN_FILE_VERSION, TRANSCRIPT_STREAM_VERSION, WORKSPACE_OBSERVATION_VERSION,
};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

const MANAGED_CLI: &str = "~/.session/bin/session-cli";
const DEFAULT_CLI_NAME: &str = "session-cli";
const UPLOAD_TIMEOUT: Duration = Duration::from_secs(120);

const INSTALL_SCRIPT: &str = r#"
set -eu
umask 077
dest_dir=$1
dest_path=$2
mkdir -p -- "$dest_dir"
[ -d "$dest_dir" ] && [ ! -L "$dest_dir" ] || { echo 'session-cli directory is unsafe' >&2; exit 65; }
chmod 700 -- "$dest_dir"
tmp=$dest_dir/.session-cli-upload.$$
if ! mkdir -- "$tmp"; then
  echo 'could not reserve session-cli upload directory' >&2
  exit 66
fi
trap 'rm -rf -- "$tmp"' EXIT HUP INT TERM
cat > "$tmp/session-cli"
chmod 755 -- "$tmp/session-cli"
mv -f -- "$tmp/session-cli" "$dest_path"
rm -rf -- "$tmp"
trap - EXIT HUP INT TERM
"#;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EnsureSkip {
    CustomCli,
    UnsupportedHost,
    AlreadyCurrent,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EnsureCliResult {
    pub path: String,
    pub version: String,
    pub installed: bool,
    pub skipped: Option<EnsureSkip>,
}

pub fn rust_target_from_uname(stdout: &str) -> Result<&'static str, String> {
    let line = stdout.trim();
    let mut parts = line.split_whitespace();
    let os = parts.next().unwrap_or("");
    let arch = parts.next().unwrap_or("");
    match (os, arch) {
        ("Linux", "x86_64") => Ok("x86_64-unknown-linux-musl"),
        ("Linux", "aarch64" | "arm64") => Ok("aarch64-unknown-linux-musl"),
        _ => Err(format!(
            "no bundled session-cli for '{line}'; linux x86_64 and aarch64 are supported"
        )),
    }
}

pub fn is_managed_cli(configured: Option<&str>) -> bool {
    match configured.map(str::trim).filter(|value| !value.is_empty()) {
        None => true,
        Some(DEFAULT_CLI_NAME) | Some(MANAGED_CLI) => true,
        Some(path) => path.ends_with("/.session/bin/session-cli"),
    }
}

pub fn bundled_cli_path(target: &str) -> Result<PathBuf, String> {
    let cwd = env::current_dir().map_err(|err| format!("failed to read cwd: {err}"))?;
    let exe_dir = env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf));
    let mut candidates = vec![cwd.join("remote-cli"), cwd.join("src-tauri/remote-cli")];
    if let Some(exe_dir) = exe_dir {
        candidates.push(exe_dir.join("remote-cli"));
        candidates.push(exe_dir.join("../Resources").join("remote-cli"));
        candidates.push(exe_dir.join("../../../src-tauri/remote-cli"));
        candidates.push(exe_dir.join("../../../remote-cli"));
    }
    let Some(dir) = candidates
        .into_iter()
        .find(|dir| dir.join(target).join("session-cli").is_file())
    else {
        return Err(format!(
            "remote terminal support is not included in Session ({target})"
        ));
    };
    Ok(dir.join(target).join("session-cli"))
}

/// Ensures a version-matching CLI exists on `remote`, updating `session_cli` to
/// the managed absolute path when Session owns the install.
pub fn prepare_remote_ref(
    state: &AppState,
    remote: &mut RemoteRef,
) -> Result<EnsureCliResult, String> {
    let host = crate::host::for_group(Some(remote));
    let result = ensure_cli(&host)?;
    if !matches!(
        result.skipped,
        Some(EnsureSkip::CustomCli | EnsureSkip::UnsupportedHost)
    ) {
        remote.session_cli = Some(result.path.clone());
        persist_managed_path(state, &remote.id, &result.path)?;
    }
    Ok(result)
}

fn persist_managed_path(state: &AppState, remote_id: &str, path: &str) -> Result<(), String> {
    if state.config().remotes.contains_key(remote_id) {
        return Ok(());
    }
    persistence::update_preferences(&state.config().workspace_root, |preferences| {
        if let Some(saved) = preferences.remotes.get_mut(remote_id) {
            let current = saved
                .session_cli
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty());
            if is_managed_cli(current) {
                saved.session_cli = Some(path.to_string());
            }
        }
    })
}

pub fn ensure_cli(host: &Host) -> Result<EnsureCliResult, String> {
    let target = host
        .remote()
        .ok_or_else(|| "session-cli provisioning requires a remote host".to_string())?;
    let configured = Some(target.session_cli.as_str());
    if !is_managed_cli(configured) {
        return Ok(EnsureCliResult {
            path: target.session_cli.clone(),
            version: String::new(),
            installed: false,
            skipped: Some(EnsureSkip::CustomCli),
        });
    }

    let expanded = host.expand_home(MANAGED_CLI)?;
    if let Some(version) = remote_cli_version(host, &expanded)
        && version == VERSION
        && remote_transcript_stream_supported(host, &expanded)
        && remote_open_file_supported(host, &expanded)
        && remote_workspace_observation_supported(host, &expanded)
    {
        return Ok(EnsureCliResult {
            path: expanded,
            version,
            installed: false,
            skipped: Some(EnsureSkip::AlreadyCurrent),
        });
    }

    let uname = remote_stdout(host, "uname", vec!["-s".to_string(), "-m".to_string()])?;
    let rust_target = match rust_target_from_uname(&uname) {
        Ok(target) => target,
        Err(_) => {
            return Ok(EnsureCliResult {
                path: DEFAULT_CLI_NAME.to_string(),
                version: String::new(),
                installed: false,
                skipped: Some(EnsureSkip::UnsupportedHost),
            });
        }
    };
    let local_cli = bundled_cli_path(rust_target)?;
    let bytes = fs::read(&local_cli).map_err(|err| {
        format!(
            "failed to read bundled session-cli {}: {err}",
            local_cli.display()
        )
    })?;

    let dest_dir = host.expand_home("~/.session/bin")?;
    install_cli(host, &dest_dir, &expanded, &bytes)?;
    let version = remote_cli_version(host, &expanded).ok_or_else(|| {
        format!("installed session-cli at {expanded} but could not read --version")
    })?;
    if !remote_transcript_stream_supported(host, &expanded) {
        return Err(
            "bundled session-cli is missing transcript streaming; rebuild remote-cli artifacts"
                .into(),
        );
    }
    if !remote_open_file_supported(host, &expanded) {
        return Err(
            "bundled session-cli is missing remote file opening; rebuild remote-cli artifacts"
                .into(),
        );
    }
    if !remote_workspace_observation_supported(host, &expanded) {
        return Err(
            "bundled session-cli is missing remote workspace observation; rebuild remote-cli artifacts"
                .into(),
        );
    }
    if version != VERSION {
        return Err(format!(
            "installed session-cli at {expanded} reported {version}, expected {VERSION}"
        ));
    }
    Ok(EnsureCliResult {
        path: expanded,
        version,
        installed: true,
        skipped: None,
    })
}

fn remote_transcript_stream_supported(host: &Host, path: &str) -> bool {
    remote_stdout(host, path, vec!["--transcript-stream-version".into()])
        .is_ok_and(|output| output.trim() == TRANSCRIPT_STREAM_VERSION)
}

fn remote_open_file_supported(host: &Host, path: &str) -> bool {
    remote_stdout(host, path, vec!["--remote-open-file-version".into()])
        .is_ok_and(|output| output.trim() == REMOTE_OPEN_FILE_VERSION)
}

fn remote_workspace_observation_supported(host: &Host, path: &str) -> bool {
    remote_stdout(host, path, vec!["--workspace-observation-version".into()])
        .is_ok_and(|output| output.trim() == WORKSPACE_OBSERVATION_VERSION)
}

fn remote_cli_version(host: &Host, path: &str) -> Option<String> {
    let output = remote_stdout(host, path, vec!["--version".to_string()]).ok()?;
    parse_version_line(&output).map(str::to_string)
}

fn remote_stdout(host: &Host, program: &str, args: Vec<String>) -> Result<String, String> {
    let command = host.command(RemoteCommand {
        program,
        args,
        ..Default::default()
    });
    let output =
        pty::remote_command_output(command, None, &format!("run {program} on {}", host.label()))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("{program} failed on {}", host.label())
        } else {
            stderr
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn install_cli(host: &Host, dest_dir: &str, dest_path: &str, bytes: &[u8]) -> Result<(), String> {
    let command = host.command(RemoteCommand {
        program: "sh",
        args: vec![
            "-c".to_string(),
            INSTALL_SCRIPT.to_string(),
            "session-install-cli".to_string(),
            dest_dir.to_string(),
            dest_path.to_string(),
        ],
        ..Default::default()
    });
    let output = pty::remote_command_output_with_timeout(
        command,
        Some(bytes.to_vec()),
        &format!("install session-cli on {}", host.label()),
        UPLOAD_TIMEOUT,
    )?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if stderr.is_empty() {
        format!("failed to install session-cli on {}", host.label())
    } else {
        format!(
            "failed to install session-cli on {}: {stderr}",
            host.label()
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uname_maps_linux_architectures() {
        assert_eq!(
            rust_target_from_uname("Linux x86_64\n").unwrap(),
            "x86_64-unknown-linux-musl"
        );
        assert_eq!(
            rust_target_from_uname("Linux aarch64").unwrap(),
            "aarch64-unknown-linux-musl"
        );
        assert_eq!(
            rust_target_from_uname("Linux arm64").unwrap(),
            "aarch64-unknown-linux-musl"
        );
        let err = rust_target_from_uname("Darwin arm64").unwrap_err();
        assert!(err.contains("Darwin arm64"), "{err}");
    }

    #[test]
    fn managed_cli_accepts_defaults_and_the_expanded_path() {
        assert!(is_managed_cli(None));
        assert!(is_managed_cli(Some("")));
        assert!(is_managed_cli(Some("session-cli")));
        assert!(is_managed_cli(Some("~/.session/bin/session-cli")));
        assert!(is_managed_cli(Some("/home/dev/.session/bin/session-cli")));
        assert!(!is_managed_cli(Some("/opt/session-cli")));
    }
}
