//! What the app tells the server about the Mac when it asks for a sign-in
//! (`devices.authorize`): the Mac's name, "<name> · macOS <version>", and
//! "Session for Mac <version>". The browser's approval page shows them.

use serde::Serialize;

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct About {
    pub name: String,
    pub device: String,
    pub app: String,
}

/// The fields from the Mac's name and system version (either unknown).
pub fn about_from(name: Option<String>, macos: Option<String>, version: &str) -> About {
    let name = name
        .map(|n| n.trim().to_owned())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "Mac".to_owned());
    let device = match macos.map(|v| v.trim().to_owned()).filter(|v| !v.is_empty()) {
        Some(v) => format!("{name} · macOS {v}"),
        None => name.clone(),
    };
    About {
        name,
        device,
        app: format!("Session for Mac {version}"),
    }
}

/// A command's first line of output, if it ran.
#[cfg(target_os = "macos")]
fn output(cmd: &str, args: &[&str]) -> Option<String> {
    let out = std::process::Command::new(cmd).args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8(out.stdout)
        .ok()
        .map(|s| s.lines().next().unwrap_or("").to_owned())
}

/// The Mac's name and macOS version (two processes: run on the blocking
/// pool, never on the main thread; review round 1 of phase 3, finding 12).
fn mac() -> (Option<String>, Option<String>) {
    #[cfg(target_os = "macos")]
    return (
        output("scutil", &["--get", "ComputerName"]),
        output("sw_vers", &["-productVersion"]),
    );
    #[cfg(not(target_os = "macos"))]
    return (std::env::var("HOSTNAME").ok(), None);
}

#[tauri::command]
pub async fn app_about<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<About, String> {
    let version = app.package_info().version.to_string();
    let (name, macos) = tauri::async_runtime::spawn_blocking(mac)
        .await
        .map_err(|e| e.to_string())?;
    Ok(about_from(name, macos, &version))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_mac_as_the_approval_page_shows_it() {
        assert_eq!(
            about_from(Some("MacBook Air\n".into()), Some("15.1".into()), "0.1.0"),
            About {
                name: "MacBook Air".into(),
                device: "MacBook Air · macOS 15.1".into(),
                app: "Session for Mac 0.1.0".into(),
            }
        );
        assert_eq!(about_from(Some("  ".into()), None, "1.0.0").device, "Mac");
    }
}
