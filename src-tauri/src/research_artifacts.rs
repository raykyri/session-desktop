//! Durable research artifact revisions. The rendered-page cache is disposable;
//! these source records are immutable and scoped to a research tree. Each branch
//! stores its parent revision explicitly instead of using the last opened revision.
//!
//! Layout: `.session/research-artifacts/<sha(tree)>/<sha(artifact)>/` holds
//! one `<revision>.json` per revision and `state/<revision>.json` for saved
//! widget inputs. Every revision can be re-created from the answer text that
//! contains it, so [`prune`] may drop revisions of removed answers and, over the
//! size cap, the oldest revisions.
use crate::research_widgets::{MAX_WIDGET_BYTES, content_hash};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::Write,
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

static STORE_LOCK: Mutex<()> = Mutex::new(());

/// Longest stored title, in characters. The frontend applies the same bound
/// (`sessionWidgetMetadata` in web/packages/shared).
pub const MAX_TITLE_CHARS: usize = 120;
/// Size cap of the revision store, the same as the rendered-page cache
/// (`research_widgets`).
pub const MAX_STORE_BYTES: u64 = 64 * 1024 * 1024;
/// Age after which a scratch file cannot belong to a write in progress.
const STALE_TMP_AGE: Duration = Duration::from_secs(10 * 60);

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactRevision {
    pub artifact_id: String,
    pub title: String,
    pub tree_id: String,
    pub node_id: String,
    pub slot: String,
    pub revision: String,
    pub content_hash: String,
    pub parent_revision: Option<String>,
    pub html: String,
    /// Milliseconds since the Unix epoch when the revision was first stored.
    #[serde(default)]
    pub created_at: u64,
    /// The fence declared a `parent=` that is not a revision hash.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub invalid_parent: bool,
    /// Computed on every read, never trusted from disk: the declared parent is
    /// malformed or not stored in this artifact (an invented hash, a tree
    /// imported or copied without its history). The revision is then shown
    /// and handled as a root.
    #[serde(default)]
    pub unresolved_parent: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactInput {
    pub tree_id: String,
    pub node_id: String,
    pub slot: String,
    pub artifact_id: Option<String>,
    pub title: Option<String>,
    pub parent_revision: Option<String>,
    pub html: String,
}

fn store_root(root: &Path) -> PathBuf {
    root.join(crate::persistence::STATE_DIR)
        .join("research-artifacts")
}

fn directory(root: &Path, tree: &str, artifact: &str) -> PathBuf {
    store_root(root)
        .join(content_hash(tree))
        .join(content_hash(artifact))
}

fn is_revision_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Same rule as `sessionWidgetMetadata` in web/packages/shared: a fence `id`
/// outside it is ignored and the widget gets a legacy identity.
pub fn is_artifact_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 128
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b':' | b'-'))
}

/// Normalize agent-generated titles to one line of at most
/// [`MAX_TITLE_CHARS`] characters so they cannot create multiple rows in the
/// interface. Control characters and line breaks become spaces, and runs of
/// whitespace collapse.
/// Same rule as `sessionWidgetTitle` in web/packages/shared.
pub fn normalize_title(title: &str) -> String {
    let single_line = title
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>();
    single_line
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(MAX_TITLE_CHARS)
        .collect()
}

/// Normalize line endings before hashing so CRLF and LF content produces the
/// same revision.
fn normalize_html(html: &str) -> String {
    html.replace("\r\n", "\n").replace('\r', "\n")
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

fn revision_path(dir: &Path, revision: &str) -> PathBuf {
    dir.join(format!("{revision}.json"))
}

fn read_revision(path: &Path, tree: &str, artifact: &str) -> Result<ArtifactRevision, String> {
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    let mut revision: ArtifactRevision =
        serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    if revision.tree_id != tree
        || revision.artifact_id != artifact
        || revision.content_hash != content_hash(&revision.html)
    {
        return Err("artifact revision failed integrity validation".into());
    }
    if revision.created_at == 0 {
        revision.created_at = fs::metadata(path)
            .and_then(|metadata| metadata.modified())
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|elapsed| elapsed.as_millis() as u64)
            .unwrap_or(0);
    }
    Ok(revision)
}

/// Whether `revision` is stored for this artifact: one file lookup.
pub fn exists(root: &Path, tree: &str, artifact: &str, revision: &str) -> bool {
    is_revision_hash(revision)
        && revision_path(&directory(root, tree, artifact), revision).is_file()
}

fn with_parent_status(root: &Path, mut revision: ArtifactRevision) -> ArtifactRevision {
    revision.unresolved_parent = revision.invalid_parent
        || revision
            .parent_revision
            .as_deref()
            .is_some_and(|parent| !exists(root, &revision.tree_id, &revision.artifact_id, parent));
    revision
}

/// All stored revisions of an artifact in lineage order: roots (including
/// revisions whose parent is unresolved) oldest first, each followed by its
/// descendants, siblings oldest first.
pub fn history(root: &Path, tree: &str, artifact: &str) -> Result<Vec<ArtifactRevision>, String> {
    let dir = directory(root, tree, artifact);
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(error) => return Err(error.to_string()),
    };
    let mut by_revision = HashMap::<String, ArtifactRevision>::new();
    for entry in entries {
        let path = entry.map_err(|error| error.to_string())?.path();
        if path.extension().is_none_or(|ext| ext != "json") {
            continue;
        }
        match read_revision(&path, tree, artifact) {
            Ok(revision) => {
                by_revision
                    .entry(revision.revision.clone())
                    .or_insert(revision);
            }
            // Skip an unreadable record without omitting the remaining records.
            // Indexing its answer again re-creates the skipped revision.
            Err(error) => eprintln!(
                "session: skipping artifact revision {}: {error}",
                path.display()
            ),
        }
    }
    let mut revisions = by_revision.into_values().collect::<Vec<_>>();
    let present = revisions
        .iter()
        .map(|revision| revision.revision.clone())
        .collect::<HashSet<_>>();
    for revision in &mut revisions {
        revision.unresolved_parent = revision.invalid_parent
            || revision
                .parent_revision
                .as_ref()
                .is_some_and(|parent| !present.contains(parent));
    }
    revisions.sort_by(|a, b| {
        (a.created_at, &a.node_id, &a.revision).cmp(&(b.created_at, &b.node_id, &b.revision))
    });
    let mut children = HashMap::<String, Vec<usize>>::new();
    let mut roots = Vec::new();
    for (index, revision) in revisions.iter().enumerate() {
        match (&revision.parent_revision, revision.unresolved_parent) {
            (Some(parent), false) => children.entry(parent.clone()).or_default().push(index),
            _ => roots.push(index),
        }
    }
    let mut order = Vec::with_capacity(revisions.len());
    let mut stack = roots.into_iter().rev().collect::<Vec<_>>();
    while let Some(index) = stack.pop() {
        order.push(index);
        if let Some(kids) = children.get(&revisions[index].revision) {
            stack.extend(kids.iter().rev());
        }
    }
    let mut slots = revisions.into_iter().map(Some).collect::<Vec<_>>();
    Ok(order
        .into_iter()
        .filter_map(|index| slots[index].take())
        .collect())
}

pub fn register(root: &Path, input: ArtifactInput) -> Result<ArtifactRevision, String> {
    let html = normalize_html(&input.html);
    if html.len() > MAX_WIDGET_BYTES
        || input.tree_id.is_empty()
        || input.node_id.is_empty()
        || input.tree_id.len() > 256
        || input.node_id.len() > 256
        || input.slot.len() > 256
    {
        return Err("invalid artifact source or owner".into());
    }
    let source_hash = content_hash(&html);
    // A fence without a valid id has no cross-answer identity. Its legacy id
    // depends only on the answer and the source, not on where the timeline
    // splits the answer into messages; identical unnamed widgets in one answer
    // therefore share one revision and its saved inputs.
    let artifact_id = input
        .artifact_id
        .filter(|id| is_artifact_id(id))
        .unwrap_or_else(|| {
            format!(
                "legacy-{}",
                content_hash(&format!("{}\0{}", input.node_id, source_hash))
            )
        });
    let (parent_revision, invalid_parent) = match input.parent_revision {
        Some(parent) if is_revision_hash(&parent) => (Some(parent), false),
        Some(_) => (None, true),
        None => (None, false),
    };
    let title = normalize_title(input.title.as_deref().unwrap_or(""));
    let title = if title.is_empty() {
        "Answer widget".to_string()
    } else {
        title
    };
    let revision_id = content_hash(
        &serde_json::to_string(&(&artifact_id, &input.node_id, &source_hash, &parent_revision))
            .map_err(|error| error.to_string())?,
    );
    if parent_revision.as_ref() == Some(&revision_id) {
        return Err("a revision cannot be its own parent".into());
    }
    let revision = ArtifactRevision {
        artifact_id,
        title,
        tree_id: input.tree_id,
        node_id: input.node_id,
        slot: input.slot,
        revision: revision_id,
        content_hash: source_hash,
        parent_revision,
        html,
        created_at: now_ms(),
        invalid_parent,
        unresolved_parent: false,
    };
    let _lock = STORE_LOCK.lock().map_err(|error| error.to_string())?;
    let dir = directory(root, &revision.tree_id, &revision.artifact_id);
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    // A revision is immutable: re-reading an answer cannot rewrite its title
    // or parent; a new source creates another revision. A parent that is not
    // stored (yet) does not block storing the child, which is then handled as
    // a root until the parent appears.
    let path = revision_path(&dir, &revision.revision);
    if path.exists() {
        let stored = read_revision(&path, &revision.tree_id, &revision.artifact_id)?;
        return Ok(with_parent_status(root, stored));
    }
    let bytes = serde_json::to_vec(&revision).map_err(|error| error.to_string())?;
    let temporary = dir.join(format!(".{}.tmp", revision.revision));
    let result = (|| -> std::io::Result<()> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        fs::rename(&temporary, &path)?;
        fs::File::open(&dir)?.sync_all()
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(temporary);
        return Err(error.to_string());
    }
    Ok(with_parent_status(root, revision))
}

/// Named `session-html` fences with a closing fence in one answer's Markdown,
/// for every artifact id. Legacy (unnamed) blocks have no cross-answer
/// identity and are registered only when displayed.
pub fn named_sources(tree: &str, node: &str, markdown: &str) -> Vec<ArtifactInput> {
    use pulldown_cmark::{CodeBlockKind, Event, Parser, Tag, TagEnd};
    static FIELDS: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r#"(?:^|\s)(id|title|parent)=("(?:\\.|[^"\\\r\n])*"|[^\s]+)"#).unwrap()
    });
    let mut current: Option<(std::ops::Range<usize>, HashMap<String, String>, String)> = None;
    let mut result = Vec::new();
    for (event, range) in Parser::new(markdown).into_offset_iter() {
        match event {
            Event::Start(Tag::CodeBlock(CodeBlockKind::Fenced(info)))
                if info.split_whitespace().next() == Some("session-html") =>
            {
                let mut values = HashMap::new();
                let opening = markdown[range.clone()].lines().next().unwrap_or("");
                for field in FIELDS.captures_iter(opening) {
                    let value = if field[2].starts_with('"') {
                        serde_json::from_str::<String>(&field[2]).ok()
                    } else {
                        Some(field[2].to_string())
                    };
                    if let Some(value) = value {
                        values.insert(field[1].to_string(), value);
                    }
                }
                current = Some((range, values, String::new()));
            }
            Event::Text(text) if current.is_some() => current.as_mut().unwrap().2.push_str(&text),
            Event::End(TagEnd::CodeBlock) => {
                if let Some((start, values, mut html)) = current.take() {
                    let Some(artifact) = values.get("id").filter(|id| is_artifact_id(id)) else {
                        continue;
                    };
                    // A closed fence adds a source line beyond its opener and
                    // parser code lines. This also handles quote/list prefixes.
                    let raw = &markdown[start.start..range.end];
                    let source_lines = raw.trim_end_matches('\n').lines().count();
                    let code_lines = html.lines().count();
                    if source_lines < code_lines + 2 {
                        continue;
                    }
                    if html.ends_with('\n') {
                        html.pop();
                    }
                    result.push(ArtifactInput {
                        tree_id: tree.into(),
                        node_id: node.into(),
                        slot: format!("source:{}", start.start),
                        artifact_id: Some(artifact.clone()),
                        title: values.get("title").cloned(),
                        parent_revision: values.get("parent").cloned(),
                        html,
                    });
                }
            }
            _ => {}
        }
    }
    result
}

/// Named sources per answer, keyed by tree then node, with the fingerprint of
/// the answer they were read from. History re-reads an answer only when its
/// fingerprint changes (the node record or its response snapshot changed).
type TreeIndex = HashMap<String, (u64, Vec<ArtifactInput>)>;
static INDEX: LazyLock<Mutex<HashMap<(PathBuf, String), TreeIndex>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Brings the tree's index up to date and stores every named revision of
/// `artifact` found in it. `nodes` lists the settled answers with their
/// fingerprints; `load` reads one answer's assistant text blocks. Returns the
/// number of sources that could not be stored.
pub fn index_tree(
    root: &Path,
    tree: &str,
    artifact: &str,
    nodes: &[(String, u64)],
    mut load: impl FnMut(&str) -> Result<Vec<String>, String>,
) -> Result<usize, String> {
    let key = (root.to_path_buf(), tree.to_string());
    let mut sources = Vec::new();
    {
        let mut index = INDEX.lock().map_err(|error| error.to_string())?;
        let cached = index.entry(key).or_default();
        cached.retain(|node, _| nodes.iter().any(|(id, _)| id == node));
        for (node, fingerprint) in nodes {
            if cached
                .get(node)
                .is_none_or(|(stored, _)| stored != fingerprint)
            {
                let found = load(node)?
                    .iter()
                    .flat_map(|text| named_sources(tree, node, text))
                    .collect();
                cached.insert(node.clone(), (*fingerprint, found));
            }
            sources.extend(
                cached[node]
                    .1
                    .iter()
                    .filter(|input| input.artifact_id.as_deref() == Some(artifact))
                    .cloned(),
            );
        }
    }
    // Registration is idempotent (one file lookup for a stored revision), and
    // a missing parent no longer fails it, so one pass in any order suffices.
    Ok(sources
        .into_iter()
        .filter(|input| register(root, input.clone()).is_err())
        .count())
}

fn forget_index(root: &Path, tree: Option<&str>) {
    if let Ok(mut index) = INDEX.lock() {
        index.retain(|(indexed_root, indexed_tree), _| {
            indexed_root != root || tree.is_some_and(|tree| tree != indexed_tree)
        });
    }
}

/// Removes a research tree's revisions and saved inputs.
pub fn remove_tree(root: &Path, tree: &str) {
    forget_index(root, Some(tree));
    let dir = store_root(root).join(content_hash(tree));
    if let Err(error) = fs::remove_dir_all(&dir)
        && error.kind() != std::io::ErrorKind::NotFound
    {
        eprintln!(
            "session: failed to remove artifact revisions {}: {error}",
            dir.display()
        );
    }
}

fn file_age_exceeds(path: &Path, age: Duration) -> bool {
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| SystemTime::now().duration_since(modified).ok())
        .is_some_and(|elapsed| elapsed > age)
}

fn remove_logged(path: &Path) {
    if let Err(error) = fs::remove_file(path)
        && error.kind() != std::io::ErrorKind::NotFound
    {
        eprintln!("session: failed to prune {}: {error}", path.display());
    }
}

/// Garbage collection, run with `prune_response_snapshots` against the final
/// set of research node ids: drops revisions whose answer no longer exists
/// and their saved inputs, saved inputs of revisions that no longer exist,
/// scratch files older than ten minutes and empty directories; then, while
/// the store exceeds `max_bytes`, the oldest revisions (and their saved
/// inputs), those without saved inputs first. A dropped revision of a live
/// answer is stored again when the answer is displayed or indexed.
pub fn prune(root: &Path, live_nodes: &HashSet<String>, max_bytes: u64) {
    let Ok(_lock) = STORE_LOCK.lock() else {
        return;
    };
    forget_index(root, None);
    struct Kept {
        path: PathBuf,
        state: Option<PathBuf>,
        bytes: u64,
        modified: SystemTime,
    }
    let mut kept = Vec::new();
    let mut total = 0u64;
    let Ok(trees) = fs::read_dir(store_root(root)) else {
        return;
    };
    for tree in trees.flatten().map(|entry| entry.path()) {
        for artifact in fs::read_dir(&tree)
            .into_iter()
            .flatten()
            .flatten()
            .map(|entry| entry.path())
        {
            let state_dir = artifact.join("state");
            let mut live_revisions = HashSet::new();
            for path in fs::read_dir(&artifact)
                .into_iter()
                .flatten()
                .flatten()
                .map(|entry| entry.path())
            {
                let name = path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("");
                if name.ends_with(".tmp") {
                    if file_age_exceeds(&path, STALE_TMP_AGE) {
                        remove_logged(&path);
                    }
                    continue;
                }
                if !name.ends_with(".json") {
                    continue;
                }
                #[derive(Deserialize)]
                #[serde(rename_all = "camelCase")]
                struct Owner {
                    node_id: String,
                    revision: String,
                }
                let owner = fs::read(&path)
                    .ok()
                    .and_then(|bytes| serde_json::from_slice::<Owner>(&bytes).ok());
                match owner {
                    Some(owner) if live_nodes.contains(&owner.node_id) => {
                        let metadata = fs::metadata(&path).ok();
                        let state = state_dir.join(format!("{}.json", owner.revision));
                        let state_bytes = fs::metadata(&state).map(|m| m.len()).ok();
                        let bytes =
                            metadata.as_ref().map_or(0, |m| m.len()) + state_bytes.unwrap_or(0);
                        total += bytes;
                        live_revisions.insert(owner.revision);
                        kept.push(Kept {
                            path: path.clone(),
                            state: state_bytes.map(|_| state),
                            bytes,
                            modified: metadata
                                .and_then(|m| m.modified().ok())
                                .unwrap_or(UNIX_EPOCH),
                        });
                    }
                    _ => remove_logged(&path),
                }
            }
            for path in fs::read_dir(&state_dir)
                .into_iter()
                .flatten()
                .flatten()
                .map(|entry| entry.path())
            {
                let name = path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("");
                let stale = match name.strip_suffix(".json") {
                    Some(revision) => !live_revisions.contains(revision),
                    None => name.ends_with(".tmp") && file_age_exceeds(&path, STALE_TMP_AGE),
                };
                if stale {
                    remove_logged(&path);
                }
            }
            let _ = fs::remove_dir(&state_dir);
            let _ = fs::remove_dir(&artifact);
        }
        let _ = fs::remove_dir(&tree);
    }
    if total <= max_bytes {
        return;
    }
    kept.sort_by_key(|entry| (entry.state.is_some(), entry.modified));
    for entry in kept {
        if total <= max_bytes {
            break;
        }
        remove_logged(&entry.path);
        if let Some(state) = &entry.state {
            remove_logged(state);
        }
        total = total.saturating_sub(entry.bytes);
    }
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactRef {
    pub tree_id: String,
    pub artifact_id: String,
    pub revision: String,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactState {
    pub enabled: bool,
    pub value: Option<serde_json::Value>,
}

const MAX_STATE_BYTES: usize = 16 * 1024;

fn state_path(root: &Path, reference: &ArtifactRef) -> Result<PathBuf, String> {
    if !exists(
        root,
        &reference.tree_id,
        &reference.artifact_id,
        &reference.revision,
    ) {
        return Err("artifact revision is unavailable".into());
    }
    Ok(directory(root, &reference.tree_id, &reference.artifact_id)
        .join("state")
        .join(format!("{}.json", reference.revision)))
}

fn read_state(path: &Path) -> Result<ArtifactState, String> {
    match fs::read(path) {
        Ok(bytes) => {
            if bytes.len() > MAX_STATE_BYTES + 128 {
                return Err("saved inputs exceed the size limit".into());
            }
            serde_json::from_slice(&bytes).map_err(|error| error.to_string())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(ArtifactState::default()),
        Err(error) => Err(error.to_string()),
    }
}

pub fn get_state(root: &Path, reference: &ArtifactRef) -> Result<ArtifactState, String> {
    read_state(&state_path(root, reference)?)
}

pub fn update_state(
    root: &Path,
    reference: &ArtifactRef,
    action: &str,
    value: Option<serde_json::Value>,
) -> Result<ArtifactState, String> {
    let _lock = STORE_LOCK.lock().map_err(|error| error.to_string())?;
    let path = state_path(root, reference)?;
    let mut state = read_state(&path)?;
    match action {
        "enable" => state.enabled = true,
        "disable" => {
            state.enabled = false;
            state.value = None;
        }
        "reset" => state.value = None,
        "save" => {
            if !state.enabled {
                return Err("remembering inputs is disabled".into());
            }
            state.value = value;
        }
        "migrate" => {
            if !state.enabled {
                return Err("enable remembering inputs before copying parent state".into());
            }
            let dir = directory(root, &reference.tree_id, &reference.artifact_id);
            let parent = read_revision(
                &revision_path(&dir, &reference.revision),
                &reference.tree_id,
                &reference.artifact_id,
            )?
            .parent_revision
            .ok_or("this revision has no parent")?;
            let source = get_state(
                root,
                &ArtifactRef {
                    revision: parent,
                    ..reference.clone()
                },
            )?;
            if !source.enabled || source.value.is_none() {
                return Err("the parent has no saved inputs".into());
            }
            state.value = source.value;
        }
        _ => return Err("unknown artifact state action".into()),
    }
    if serde_json::to_vec(&state.value)
        .map_err(|error| error.to_string())?
        .len()
        > MAX_STATE_BYTES
    {
        return Err("saved inputs exceed the 16 KiB limit".into());
    }
    let bytes = serde_json::to_vec(&state).map_err(|error| error.to_string())?;
    let dir = path.parent().unwrap();
    fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    let temporary = path.with_extension("tmp");
    crate::persistence::write_synced(&temporary, &bytes).map_err(|error| error.to_string())?;
    fs::rename(&temporary, &path).map_err(|error| error.to_string())?;
    fs::File::open(dir)
        .and_then(|file| file.sync_all())
        .map_err(|error| error.to_string())?;
    Ok(state)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "session-artifact-{name}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    fn input(html: &str, node: &str, parent: Option<String>) -> ArtifactInput {
        ArtifactInput {
            tree_id: "tree".into(),
            node_id: node.into(),
            slot: "0".into(),
            artifact_id: Some("chart".into()),
            title: Some("Chart".into()),
            parent_revision: parent,
            html: html.into(),
        }
    }

    #[test]
    fn pins_are_immutable_and_branches_keep_their_parent() {
        let temp = temp_root("pins");
        let root = register(&temp, input("root", "n1", None)).unwrap();
        register(&temp, input("left", "n2", Some(root.revision.clone()))).unwrap();
        register(&temp, input("right", "n3", Some(root.revision.clone()))).unwrap();
        let mut changed = input("root", "n1", None);
        changed.title = Some("changed".into());
        assert_eq!(register(&temp, changed).unwrap().title, "Chart");
        let history = history(&temp, "tree", "chart").unwrap();
        assert_eq!(history.len(), 3);
        assert_eq!(history[0].revision, root.revision, "the root comes first");
        assert_eq!(
            history
                .iter()
                .filter(|r| r.parent_revision.as_ref() == Some(&root.revision))
                .count(),
            2
        );
        assert!(history.iter().all(|r| !r.unresolved_parent));
        assert!(
            super::history(&temp, "other-tree", "chart")
                .unwrap()
                .is_empty()
        );
        fs::remove_dir_all(&temp).unwrap();
    }

    #[test]
    fn unresolvable_parents_register_as_roots_and_resolve_when_the_parent_arrives() {
        let temp = temp_root("unresolved");
        // A child registered before its parent (child-first display order).
        let parent_input = input("parent", "n1", None);
        let invented = "a".repeat(64);
        let orphan = register(&temp, input("orphan", "n4", Some(invented.clone()))).unwrap();
        assert!(orphan.unresolved_parent);
        assert_eq!(orphan.parent_revision.as_deref(), Some(invented.as_str()));
        for malformed in ["not-a-hash", "A".repeat(64).as_str(), ""] {
            let revision =
                register(&temp, input("malformed", "n5", Some(malformed.into()))).unwrap();
            assert!(revision.unresolved_parent && revision.invalid_parent);
            assert_eq!(revision.parent_revision, None);
        }
        let parent_revision = {
            let probe = temp_root("probe");
            let revision = register(&probe, parent_input.clone()).unwrap().revision;
            fs::remove_dir_all(probe).unwrap();
            revision
        };
        let child = register(&temp, input("child", "n2", Some(parent_revision.clone()))).unwrap();
        assert!(child.unresolved_parent, "the parent is not stored yet");
        let history_before = history(&temp, "tree", "chart").unwrap();
        assert!(
            history_before
                .iter()
                .find(|r| r.revision == child.revision)
                .unwrap()
                .unresolved_parent
        );
        register(&temp, parent_input).unwrap();
        let history_after = history(&temp, "tree", "chart").unwrap();
        let child_after = history_after
            .iter()
            .position(|r| r.revision == child.revision)
            .unwrap();
        let parent_after = history_after
            .iter()
            .position(|r| r.revision == parent_revision)
            .unwrap();
        assert!(!history_after[child_after].unresolved_parent);
        assert!(
            parent_after < child_after,
            "lineage order puts the parent first"
        );
        // Saved inputs work on a revision with an unresolved parent.
        let reference = ArtifactRef {
            tree_id: "tree".into(),
            artifact_id: "chart".into(),
            revision: orphan.revision.clone(),
        };
        update_state(&temp, &reference, "enable", None).unwrap();
        assert!(update_state(&temp, &reference, "migrate", None).is_err());
        fs::remove_dir_all(&temp).unwrap();
    }

    #[test]
    fn titles_ids_and_line_endings_are_normalised() {
        let temp = temp_root("normalise");
        let mut crlf = input("<p>a</p>\r\n<p>b</p>", "n1", None);
        crlf.title = Some(format!("Line one\nLine\ttwo {}", "x".repeat(200)));
        let lf = input("<p>a</p>\n<p>b</p>", "n1", None);
        let a = register(&temp, crlf).unwrap();
        let b = register(&temp, lf).unwrap();
        assert_eq!(a.revision, b.revision);
        assert!(!a.html.contains('\r'));
        assert!(a.title.starts_with("Line one Line two x"));
        assert_eq!(a.title.chars().count(), MAX_TITLE_CHARS);
        let mut bad_id = input("x", "n1", None);
        bad_id.artifact_id = Some("-bad id".into());
        assert!(
            register(&temp, bad_id)
                .unwrap()
                .artifact_id
                .starts_with("legacy-")
        );
        // Legacy identity ignores the slot, which depends on timeline
        // segmentation.
        let legacy = |slot: &str| ArtifactInput {
            artifact_id: None,
            slot: slot.into(),
            ..input("legacy", "n9", None)
        };
        assert_eq!(
            register(&temp, legacy("item-1:0:0")).unwrap().artifact_id,
            register(&temp, legacy("item-3:2:40")).unwrap().artifact_id
        );
        fs::remove_dir_all(&temp).unwrap();
    }

    #[test]
    fn prune_drops_removed_answers_stale_scratch_files_and_enforces_the_cap() {
        let temp = temp_root("prune");
        let kept = register(&temp, input("kept", "live", None)).unwrap();
        let gone = register(&temp, input("gone", "removed", None)).unwrap();
        let reference = |revision: &str| ArtifactRef {
            tree_id: "tree".into(),
            artifact_id: "chart".into(),
            revision: revision.into(),
        };
        update_state(&temp, &reference(&kept.revision), "enable", None).unwrap();
        update_state(&temp, &reference(&gone.revision), "enable", None).unwrap();
        let dir = directory(&temp, "tree", "chart");
        let stale = dir.join(".deadbeef.tmp");
        let fresh = dir.join(".cafe.tmp");
        fs::write(&stale, b"x").unwrap();
        fs::write(&fresh, b"x").unwrap();
        let old = SystemTime::now() - Duration::from_secs(3600);
        fs::File::options()
            .write(true)
            .open(&stale)
            .unwrap()
            .set_modified(old)
            .unwrap();
        let live = HashSet::from(["live".to_string()]);
        prune(&temp, &live, MAX_STORE_BYTES);
        assert!(exists(&temp, "tree", "chart", &kept.revision));
        assert!(!exists(&temp, "tree", "chart", &gone.revision));
        assert!(
            dir.join("state")
                .join(format!("{}.json", kept.revision))
                .exists()
        );
        assert!(
            !dir.join("state")
                .join(format!("{}.json", gone.revision))
                .exists()
        );
        assert!(!stale.exists() && fresh.exists());
        // Over the cap, revisions without saved inputs go first.
        let plain = register(&temp, input("plain", "live", None)).unwrap();
        prune(&temp, &live, 1);
        assert!(!exists(&temp, "tree", "chart", &plain.revision));
        assert!(!exists(&temp, "tree", "chart", &kept.revision));
        fs::remove_file(&fresh).unwrap();
        prune(&temp, &live, MAX_STORE_BYTES);
        assert!(!store_root(&temp).join(content_hash("tree")).exists());
        register(&temp, input("again", "live", None)).unwrap();
        remove_tree(&temp, "tree");
        assert!(history(&temp, "tree", "chart").unwrap().is_empty());
        let _ = fs::remove_dir_all(&temp);
    }

    #[test]
    fn indexing_reads_each_answer_once_until_it_changes() {
        let temp = temp_root("index");
        let text = |parent: Option<&str>, body: &str| {
            let parent = parent.map(|p| format!(" parent={p}")).unwrap_or_default();
            format!("```session-html id=chart{parent}\n{body}\n```\n")
        };
        let root_revision = {
            let probe = temp_root("index-probe");
            let revision = register(&probe, input("root", "n1", None))
                .unwrap()
                .revision;
            fs::remove_dir_all(probe).unwrap();
            revision
        };
        let answers = HashMap::from([
            ("n1".to_string(), vec![text(None, "root")]),
            ("n2".to_string(), vec![text(Some(&root_revision), "child")]),
        ]);
        let loads = std::cell::Cell::new(0);
        let mut load = |node: &str| -> Result<Vec<String>, String> {
            loads.set(loads.get() + 1);
            Ok(answers[node].clone())
        };
        // Child before parent in node order.
        let nodes = vec![("n2".to_string(), 1), ("n1".to_string(), 1)];
        assert_eq!(
            index_tree(&temp, "tree", "chart", &nodes, &mut load).unwrap(),
            0
        );
        assert_eq!(
            index_tree(&temp, "tree", "chart", &nodes, &mut load).unwrap(),
            0
        );
        assert_eq!(loads.get(), 2, "unchanged answers are not read again");
        let history = history(&temp, "tree", "chart").unwrap();
        assert_eq!(history.len(), 2);
        assert!(history.iter().all(|r| !r.unresolved_parent));
        let changed = vec![("n2".to_string(), 2), ("n1".to_string(), 1)];
        index_tree(&temp, "tree", "chart", &changed, &mut load).unwrap();
        assert_eq!(loads.get(), 3, "a changed answer is read again");
        fs::remove_dir_all(&temp).unwrap();
    }

    #[test]
    fn indexes_complete_named_fences_only() {
        for prefix in ["", "> ", "  "] {
            let markdown = format!(
                "{prefix}```session-html id=chart title=\"A \\\"quoted\\\" chart\"\n{prefix}<p>hello</p>\n{prefix}```\n"
            );
            let sources = named_sources("tree", "node", &markdown);
            assert_eq!(sources.len(), 1, "{markdown}");
            assert_eq!(sources[0].html, "<p>hello</p>");
            assert_eq!(sources[0].title.as_deref(), Some("A \"quoted\" chart"));
        }
        assert!(named_sources("t", "n", "```session-html id=chart\n<p>unfinished</p>").is_empty());
        assert!(named_sources("t", "n", "```session-html\nx\n```").is_empty());
        assert!(named_sources("t", "n", "```session-html id=-bad\nx\n```").is_empty());
    }

    #[test]
    fn reverting_and_unchanged_results_are_new_revisions() {
        let root = temp_root("lineage");
        let make = |node: &str, html: &str, parent| ArtifactInput {
            tree_id: "t".into(),
            node_id: node.into(),
            slot: "0".into(),
            artifact_id: Some("a".into()),
            title: None,
            parent_revision: parent,
            html: html.into(),
        };
        let a = register(&root, make("n1", "a", None)).unwrap();
        let b = register(&root, make("n2", "b", Some(a.revision.clone()))).unwrap();
        let revert = register(&root, make("n3", "a", Some(b.revision.clone()))).unwrap();
        let unchanged = register(&root, make("n4", "a", Some(revert.revision.clone()))).unwrap();
        assert_eq!(a.content_hash, revert.content_hash);
        assert_ne!(a.revision, revert.revision);
        assert_ne!(unchanged.revision, revert.revision);
        let order = history(&root, "t", "a")
            .unwrap()
            .into_iter()
            .map(|r| r.revision)
            .collect::<Vec<_>>();
        assert_eq!(
            order,
            [a.revision, b.revision, revert.revision, unchanged.revision]
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn state_requires_opt_in_and_migration_is_explicit() {
        let root = temp_root("state");
        let make = |node: &str, parent| ArtifactInput {
            tree_id: "t".into(),
            node_id: node.into(),
            slot: "0".into(),
            artifact_id: Some("a".into()),
            title: None,
            parent_revision: parent,
            html: node.into(),
        };
        let parent = register(&root, make("n1", None)).unwrap();
        let child = register(&root, make("n2", Some(parent.revision.clone()))).unwrap();
        let reference = |revision| ArtifactRef {
            tree_id: "t".into(),
            artifact_id: "a".into(),
            revision,
        };
        let p = reference(parent.revision);
        let c = reference(child.revision);
        let value = Some(serde_json::json!({"version":1,"rate":4}));
        assert!(!get_state(&root, &p).unwrap().enabled);
        assert!(update_state(&root, &p, "save", value.clone()).is_err());
        update_state(&root, &p, "enable", None).unwrap();
        update_state(&root, &p, "save", value.clone()).unwrap();
        assert!(
            update_state(
                &root,
                &p,
                "save",
                Some(serde_json::json!("x".repeat(MAX_STATE_BYTES)))
            )
            .is_err()
        );
        assert_eq!(get_state(&root, &p).unwrap().value, value);
        update_state(&root, &c, "enable", None).unwrap();
        assert!(get_state(&root, &c).unwrap().value.is_none());
        assert_eq!(
            update_state(&root, &c, "migrate", None).unwrap().value,
            value
        );
        assert!(
            update_state(&root, &c, "reset", None)
                .unwrap()
                .value
                .is_none()
        );
        let off = update_state(&root, &p, "disable", None).unwrap();
        assert!(!off.enabled && off.value.is_none());
        assert!(update_state(&root, &c, "migrate", None).is_err());
        assert!(get_state(&root, &reference("b".repeat(64))).is_err());
        assert_eq!(
            history(&root, "t", "a").unwrap().len(),
            2,
            "state files are not revisions"
        );
        fs::remove_dir_all(root).unwrap();
    }
}
