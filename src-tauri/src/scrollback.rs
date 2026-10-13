//! Terminal scrollback left on disk by builds that hosted terminal panes.

use std::fs;
use std::path::{Path, PathBuf};

/// The directory that held each pane's `.pty` log, remote history
/// checkpoints, and their scratch files.
fn scrollback_dir(workspace_root: &Path) -> PathBuf {
    workspace_root.join(".session").join("terminal")
}

/// Deletes the scrollback directory. Session creates no terminal panes, so
/// nothing in it is live; the logs hold raw terminal output that older builds
/// kept owner-only as secret-bearing. A symlink at the path is removed, not
/// followed. Failures leave the files for the next startup.
pub fn remove_legacy_scrollback(workspace_root: &Path) {
    let _ = fs::remove_dir_all(scrollback_dir(workspace_root));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn legacy_scrollback_is_removed_and_a_missing_directory_is_fine() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let workspace = std::env::temp_dir().join(format!("session-scrollback-{nanos}"));
        let dir = scrollback_dir(&workspace);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("pane-1.pty"), b"output").unwrap();
        fs::write(dir.join("pane-1.trim.1.tmp"), b"scratch").unwrap();
        fs::write(workspace.join(".session").join("state.json"), b"{}").unwrap();

        remove_legacy_scrollback(&workspace);
        assert!(!dir.exists());
        assert!(workspace.join(".session").join("state.json").exists());
        remove_legacy_scrollback(&workspace);

        let _ = fs::remove_dir_all(&workspace);
    }
}
