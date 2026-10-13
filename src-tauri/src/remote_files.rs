//! Local snapshots uploaded by `session open` from SSH-backed panes.
//!
//! Each upload gets its own owner-only directory and only the completed file is
//! granted to the pane's preview token. The directory is never a file-server
//! root, so relative references from HTML cannot pull in sibling remote files.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

const STORE_DIR: &str = "remote-files";
const ORPHAN_GRACE: Duration = Duration::from_secs(60 * 60);

pub fn store_root(workspace_root: &Path) -> PathBuf {
    workspace_root.join(".session").join(STORE_DIR)
}

fn store_root_is_directory(root: &Path) -> bool {
    fs::symlink_metadata(root)
        .is_ok_and(|metadata| metadata.is_dir() && !metadata.file_type().is_symlink())
}

/// Returns the canonical path only when it is one complete file in Session's
/// managed remote-preview store.
pub fn resolve_staged_file(workspace_root: &Path, path: &Path) -> Option<PathBuf> {
    let store = store_root(workspace_root);
    if !store_root_is_directory(&store) {
        return None;
    }
    let root = fs::canonicalize(store).ok()?;
    let canonical = fs::canonicalize(path).ok()?;
    (canonical.is_file() && canonical.starts_with(&root)).then_some(canonical)
}

/// Removes old upload directories that no persisted artifact references. The
/// grace period preserves the frontend's undo window and avoids racing a newly
/// completed shell-pane upload during startup.
pub fn remove_orphaned(workspace_root: &Path, referenced: &[PathBuf]) {
    let root = store_root(workspace_root);
    if !store_root_is_directory(&root) {
        return;
    }
    let Ok(canonical_root) = fs::canonicalize(&root) else {
        return;
    };
    let kept = referenced
        .iter()
        .filter_map(|path| resolve_staged_file(workspace_root, path))
        .filter_map(|path| path.parent().map(Path::to_path_buf))
        .collect::<HashSet<_>>();
    let Ok(entries) = fs::read_dir(&canonical_root) else {
        return;
    };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let path = entry.path();
        let old_enough = entry
            .metadata()
            .ok()
            .and_then(|meta| meta.modified().ok())
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age >= ORPHAN_GRACE);
        if old_enough && !kept.contains(&path) {
            let _ = fs::remove_dir_all(path);
        }
    }
}
