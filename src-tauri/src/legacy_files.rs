//! Files left on disk by builds that hosted terminal panes.

use std::fs;
use std::path::{Path, PathBuf};

/// `.session/terminal` held each pane's `.pty` scrollback log, remote history
/// checkpoints and their scratch files. `.session/remote-files` held the
/// snapshots `session open` uploaded from SSH-backed panes for the artifact
/// tray.
fn legacy_dirs(workspace_root: &Path) -> [PathBuf; 2] {
    let state_dir = workspace_root.join(".session");
    [state_dir.join("terminal"), state_dir.join("remote-files")]
}

/// Deletes both directories. Session creates no terminal panes and has no
/// artifact tray, so nothing in them is live; the scrollback logs hold raw
/// terminal output that older builds kept owner-only as secret-bearing. A
/// symlink at either path is removed, not followed. Failures leave the files
/// for the next startup.
pub fn remove_terminal_leftovers(workspace_root: &Path) {
    for dir in legacy_dirs(workspace_root) {
        let _ = fs::remove_dir_all(dir);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn terminal_leftovers_are_removed_and_missing_directories_are_fine() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let workspace = std::env::temp_dir().join(format!("session-legacy-files-{nanos}"));
        let [scrollback, uploads] = legacy_dirs(&workspace);
        fs::create_dir_all(&scrollback).unwrap();
        fs::write(scrollback.join("pane-1.pty"), b"output").unwrap();
        fs::write(scrollback.join("pane-1.trim.1.tmp"), b"scratch").unwrap();
        fs::create_dir_all(uploads.join("upload-1")).unwrap();
        fs::write(uploads.join("upload-1").join("report.html"), b"<p>").unwrap();
        fs::write(workspace.join(".session").join("state.json"), b"{}").unwrap();

        remove_terminal_leftovers(&workspace);
        assert!(!scrollback.exists());
        assert!(!uploads.exists());
        assert!(workspace.join(".session").join("state.json").exists());
        remove_terminal_leftovers(&workspace);

        let _ = fs::remove_dir_all(&workspace);
    }
}
