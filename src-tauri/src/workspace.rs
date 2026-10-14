use crate::state::AppState;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

static RESEARCH_WORKSPACE_CREATION_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));
static AGENT_WORKSPACE_CREATION_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

/// Serializes research-workspace mutations against research launches. The
/// folder-replace and remove commands make a compound decision — "no active
/// runs / no trees → commit" — that is not atomic under the
/// model lock alone: a tree or follow-up admitted between the check and the
/// commit would either launch into the old directory or silently survive a
/// removal. Launch admission (`create_research_tree` / `fork_research_node`)
/// takes this same guard, so the check-then-commit windows close.
pub fn lock_research_workspace_mutations() -> Result<std::sync::MutexGuard<'static, ()>, String> {
    RESEARCH_WORKSPACE_CREATION_LOCK
        .lock()
        .map_err(|_| "research workspace mutation lock poisoned".to_string())
}

/// Which application mode owns a workspace. `Terminal` is the default for
/// groups saved by builds that hosted terminal panes.
/// Ownership is durable: callers must never infer it from a transient agent or
/// research-node binding.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkspaceScope {
    #[default]
    Terminal,
    Research,
}

/// Checks that a research launch targets an available Research-scoped
/// workspace.
pub fn validate_launch_workspace(state: &AppState, group_id: &str) -> Result<GroupInfo, String> {
    let group = state
        .group(group_id)?
        .ok_or_else(|| format!("workspace {group_id} was not found"))?;
    if group.scope != WorkspaceScope::Research {
        return Err("research requires a Research-scoped workspace".to_string());
    }
    if !Path::new(&group.dir).is_dir() {
        return Err(format!(
            "research folder '{}' is unavailable; restore it at that path before launching another run",
            group.dir
        ));
    }
    Ok(group)
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupInfo {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name_override: Option<String>,
    /// User-facing working directory represented by this group.
    pub dir: String,
    /// Where earlier builds wrote the group's manifest
    /// (`<managedDir>/.session/group.json`). Nothing reads that file, and
    /// this build neither writes it nor creates the directory. A new group
    /// still gets a path under the workspace root, because earlier builds
    /// require the field and write their manifest there. Existing
    /// directories are left on disk.
    pub managed_dir: String,
    pub base_repo: Option<String>,
    pub created_at: u128,
    #[serde(default)]
    pub scope: WorkspaceScope,
    /// Identifies the exact portable archive whose import committed this
    /// workspace. Kept until that archive is removed so startup can safely
    /// finish cleanup after a crash without touching an unrelated archive.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub imported_research_archive_id: Option<String>,
    pub agents: Vec<String>,
}

impl GroupInfo {}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInfo {
    pub id: String,
    pub group_id: String,
    pub adapter: String,
    pub worktree_dir: String,
    /// The terminal pane hosting the agent, in records saved by builds that
    /// had panes. Never set now and never written; restore drops a record
    /// that carries one.
    #[serde(default, skip_serializing)]
    pub pane_id: Option<String>,
    pub session_id: Option<String>,
    pub transcript_path: Option<String>,
    pub status: AgentStatus,
    pub model: Option<String>,
    /// Reasoning effort level the session was launched with. Persisted like
    /// `model` so respawns, resumes, and forks keep the session's configured
    /// effort. Absent when the adapter default applies.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch_id: Option<String>,
    pub created_at: u128,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AgentStatus {
    Starting,
    Running,
    AwaitingInput,
    AwaitingPermission,
    Done,
    #[serde(alias = "stopped")]
    Idle,
    Failed,
}

impl AgentStatus {}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateGroupRequest {
    pub name: Option<String>,
    pub dir: Option<String>,
    pub after_group_id: Option<String>,
    pub base_repo: Option<String>,
}

#[derive(Clone, Debug)]
pub struct PrepareAgentWorkspaceRequest {
    pub group_id: String,
    pub base_repo: Option<String>,
    pub adapter: String,
    pub model: Option<String>,
    /// Reasoning effort level for the new session, recorded on the agent like
    /// `model`.
    pub effort: Option<String>,
}

/// Creates a durable research workspace rooted at `dir`. Research workspaces
/// share the group/agent execution machinery, but their explicit scope gives
/// them independent navigation and retention policy.
pub fn create_research_workspace(
    state: &AppState,
    name: Option<String>,
    dir: String,
) -> Result<GroupInfo, String> {
    let _guard = lock_research_workspace_mutations()?;
    create_research_workspace_locked(state, name, dir)
}

/// Whether an existing workspace record refers to the requested directory.
/// Records are stored canonicalized, but a record whose folder is currently
/// missing cannot be re-canonicalized (and legacy-migrated records may hold
/// non-canonical paths), so fall back to comparing the stored string against
/// both the canonical and as-picked forms of the requested path. Without the
/// fallback, re-picking a folder while the record's copy was unreadable
/// created a second workspace for the same directory.
fn group_dir_matches(group: &GroupInfo, canonical: &Path, requested: &Path) -> bool {
    let stored = Path::new(&group.dir);
    match fs::canonicalize(stored) {
        Ok(stored_canonical) => stored_canonical == canonical,
        Err(_) => stored == canonical || stored == requested,
    }
}

/// Reads a user-picked folder's detached archive for open/repoint decisions.
/// An unreadable archive (corrupted manifest, a version from a newer Session, a
/// damaged response file) must not strand the user with a bare decode error:
/// these call sites are the only in-app way to use the folder at all, so the
/// error has to say where the archive lives and how to proceed without it.
fn read_detached_research_for_folder(
    folder: &Path,
) -> Result<Option<crate::research::DetachedResearchBundle>, String> {
    crate::research::read_detached_research(folder).map_err(|err| {
        format!(
            "{} contains detached research that could not be read: {err}. To use the folder without restoring its history, move {} out of the folder and keep it somewhere safe.",
            folder.display(),
            crate::research::detached_research_archive_location(folder).display()
        )
    })
}

fn create_research_workspace_locked(
    state: &AppState,
    name: Option<String>,
    dir: String,
) -> Result<GroupInfo, String> {
    let requested = PathBuf::from(&dir);
    let canonical = fs::canonicalize(&requested).map_err(|err| {
        format!(
            "research folder {} is unavailable: {err}",
            requested.display()
        )
    })?;
    if !canonical.is_dir() {
        return Err(format!(
            "research folder {} is not a directory",
            canonical.display()
        ));
    }
    if let Some(existing) = state.list_groups()?.into_iter().find(|group| {
        group.scope == WorkspaceScope::Research && group_dir_matches(group, &canonical, &requested)
    }) {
        return Ok(existing);
    }
    if let Some(bundle) = read_detached_research_for_folder(&canonical)? {
        // A completed node whose response file is absent from the archive
        // (a partial copy between machines, a hand-deleted file) is already
        // damaged outside Session — refusing the whole import here turned one
        // missing file into a folder that could never be opened again,
        // stranding every intact prompt and answer alongside it. Import
        // everything that survived instead; import_detached_research clears
        // the snapshot stamp on nodes that arrive without a response, so the
        // node restores with its prompt and preview and never claims a
        // durable answer it does not have.
        for node in &bundle.archive.nodes {
            if node.status() == crate::research::ResearchNodeStatus::Complete
                && !bundle.responses.contains_key(&node.id)
            {
                eprintln!(
                    "session: detached research response {} is missing from {}; importing the node without it",
                    node.id,
                    canonical.display()
                );
            }
        }
        let archive_name = bundle.archive.workspace.name_override.clone();
        let mut group = create_group_record(
            state,
            CreateGroupRequest {
                name: name.or(archive_name),
                dir: Some(canonical.display().to_string()),
                after_group_id: None,
                base_repo: None,
            },
            WorkspaceScope::Research,
        )?;
        group.imported_research_archive_id = Some(bundle.archive.archive_id.clone());
        // Before the nodes that attach them. If the import then fails, the
        // copies are unreferenced and the next clean startup returns them to
        // pending.
        crate::research_images::import_archived(&state.config().workspace_root, &bundle.images);
        let imported = state.import_detached_research(
            group.clone(),
            bundle.archive.tree_order,
            bundle.archive.trees,
            bundle.archive.folders,
            bundle.archive.membership,
            bundle.archive.parents,
            bundle.archive.nodes,
            bundle.responses,
        )?;
        if let Err(err) = reconcile_imported_research_archive(state, &imported) {
            // The global import and its cleanup receipt are already durable.
            // Startup retries this exact archive instead of risking deletion
            // of some other archive later placed in the folder.
            eprintln!("session: {err}");
        }
        return state
            .group(&imported.id)?
            .ok_or_else(|| format!("imported research workspace {} disappeared", imported.id));
    }
    create_scoped_group(
        state,
        CreateGroupRequest {
            name,
            dir: Some(canonical.display().to_string()),
            after_group_id: None,
            base_repo: None,
        },
        WorkspaceScope::Research,
    )
}

pub fn reconcile_imported_research_archives(state: &AppState) {
    let groups = match state.list_groups() {
        Ok(groups) => groups,
        Err(err) => {
            eprintln!("session: failed to list imported research cleanup receipts: {err}");
            return;
        }
    };
    for group in groups.into_iter().filter(|group| {
        group.scope == WorkspaceScope::Research && group.imported_research_archive_id.is_some()
    }) {
        if let Err(err) = reconcile_imported_research_archive(state, &group) {
            eprintln!("session: {err}");
        }
    }
}

fn reconcile_imported_research_archive(state: &AppState, group: &GroupInfo) -> Result<(), String> {
    let Some(expected_archive_id) = group.imported_research_archive_id.as_deref() else {
        return Ok(());
    };
    let folder = Path::new(&group.dir);
    match crate::research::read_detached_research(folder)? {
        Some(bundle) if bundle.archive.archive_id == expected_archive_id => {
            crate::research::remove_detached_research(folder, bundle.pending)?;
        }
        Some(_) => {
            // The receipt belongs to an older import. Preserve the different
            // archive now in the folder and merely retire the stale receipt.
        }
        None => {}
    }
    let mut updated = group.clone();
    updated.imported_research_archive_id = None;
    state.update_group(updated)
}

pub fn ensure_default_research_workspace(state: &AppState) -> Result<GroupInfo, String> {
    let _guard = lock_research_workspace_mutations()?;
    let dir = state.default_research_dir();
    fs::create_dir_all(&dir).map_err(|err| {
        format!(
            "failed to create default research directory {}: {err}",
            dir.display()
        )
    })?;
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).map_err(|err| {
        format!(
            "failed to restrict default research directory {}: {err}",
            dir.display()
        )
    })?;
    let canonical = fs::canonicalize(&dir).unwrap_or_else(|_| dir.clone());
    if let Some(existing) = state.list_groups()?.into_iter().find(|group| {
        group.scope == WorkspaceScope::Research && group_dir_matches(group, &canonical, &dir)
    }) {
        return Ok(existing);
    }
    create_research_workspace_locked(
        state,
        Some("Default workspace".to_string()),
        canonical.display().to_string(),
    )
}

pub fn rename_research_workspace(
    state: &AppState,
    workspace_id: &str,
    name: Option<String>,
) -> Result<GroupInfo, String> {
    // Keep rename and removal serialized so their read-modify-write updates
    // cannot silently revert one another in the model.
    let _guard = lock_research_workspace_mutations()?;
    let workspace = require_research_workspace(state, workspace_id)?;
    rename_group_record(state, workspace, name)
}

/// Moves a research workspace to a different directory. While a folder is
/// open its research history (trees, nodes, responses) lives in Session's global
/// state, so a move repoints the durable record and relocates only the
/// research-specific state a folder can carry — a detached `.session` research
/// archive belonging to this workspace. The old folder itself and the rest of
/// its contents are never modified or deleted.
pub fn move_research_workspace(
    state: &AppState,
    workspace_id: &str,
    dir: String,
) -> Result<GroupInfo, String> {
    let _guard = lock_research_workspace_mutations()?;
    let mut workspace = require_research_workspace(state, workspace_id)?;
    // Retire a fresh import's cleanup receipt first, exactly like removal:
    // the receipt's archive is an already-imported duplicate that must be
    // deleted where it stands, not carried along as if it were history.
    if workspace.imported_research_archive_id.is_some() {
        reconcile_imported_research_archive(state, &workspace)?;
        workspace = require_research_workspace(state, workspace_id)?;
    }
    let dependencies = state.research_workspace_dependencies(workspace_id)?;
    let display_name = workspace
        .name_override
        .as_deref()
        .unwrap_or(&workspace.name);
    if dependencies.has_active_runs {
        return Err(format!(
            "research folder '{display_name}' cannot be moved while it has active runs"
        ));
    }
    let requested = PathBuf::from(&dir);
    let canonical = fs::canonicalize(&requested).map_err(|err| {
        format!(
            "research folder {} is unavailable: {err}",
            requested.display()
        )
    })?;
    if !canonical.is_dir() {
        return Err(format!(
            "research folder {} is not a directory",
            canonical.display()
        ));
    }
    if group_dir_matches(&workspace, &canonical, &requested) {
        return Ok(workspace);
    }
    if let Some(existing) = state.list_groups()?.into_iter().find(|group| {
        group.id != workspace.id
            && group.scope == WorkspaceScope::Research
            && group_dir_matches(group, &canonical, &requested)
    }) {
        return Err(format!(
            "{} is already open as research folder '{}'",
            canonical.display(),
            existing.name_override.as_deref().unwrap_or(&existing.name)
        ));
    }
    // A destination carrying its own detached history belongs to some other
    // research folder; moving on top of it would hide that archive behind
    // this workspace's record until removal, which would then refuse to
    // overwrite it. Opening it as its own folder is the deliberate path.
    if read_detached_research_for_folder(&canonical)?.is_some() {
        return Err(format!(
            "{} already contains detached research history; open it as its own research folder instead",
            canonical.display()
        ));
    }
    // The one research-specific thing the old folder can hold for a live
    // workspace is its own pending archive (a removal interrupted before its
    // global commit). Rewrite it into the destination before repointing so a
    // crash between the two steps leaves both copies rather than neither,
    // then clear the source copy. Foreign archives — a different workspace's
    // detached history sitting in the folder — stay with the folder they
    // describe.
    match crate::research::read_detached_research(Path::new(&workspace.dir)) {
        Ok(Some(bundle)) if bundle.archive.workspace.id == workspace.id => {
            crate::research::write_detached_research_pending(
                &canonical,
                &bundle.archive,
                &bundle.responses,
            )?;
            crate::research::write_detached_research_images(&canonical, &bundle.images)?;
            if !bundle.pending {
                crate::research::commit_detached_research(&canonical)?;
            }
            crate::research::remove_detached_research(Path::new(&workspace.dir), bundle.pending)?;
        }
        Ok(_) => {}
        Err(err) => {
            // Unreadable, so its owner cannot be identified — and a live
            // workspace's own history is safe in global state either way.
            // Leave it with the old folder rather than failing the move.
            eprintln!(
                "session: leaving unreadable detached research behind in {}: {err}",
                workspace.dir
            );
        }
    }
    workspace.dir = canonical.display().to_string();
    workspace.name = group_name_for_dir(&canonical);
    state.update_group(workspace.clone())?;
    state.emit(crate::events::SessionEvent::new(
        "group.updated",
        None,
        None,
        serde_json::json!({ "group": workspace.clone() }),
    ));
    Ok(workspace)
}

pub fn remove_research_workspace(
    state: &AppState,
    workspace_id: &str,
) -> Result<Vec<String>, String> {
    let _guard = lock_research_workspace_mutations()?;
    let mut workspace = require_research_workspace(state, workspace_id)?;
    if workspace.imported_research_archive_id.is_some() {
        reconcile_imported_research_archive(state, &workspace)?;
        workspace = require_research_workspace(state, workspace_id)?;
    }
    let dependencies = state.research_workspace_dependencies(workspace_id)?;
    let display_name = workspace
        .name_override
        .as_deref()
        .unwrap_or(&workspace.name);
    if dependencies.has_active_runs {
        return Err(format!(
            "research folder '{display_name}' cannot be removed while it has active runs"
        ));
    }
    let archive = state.detached_research_archive(workspace_id)?;
    let detached_tree_ids = archive
        .trees
        .iter()
        .map(|tree| tree.id.clone())
        .collect::<Vec<_>>();
    if archive.trees.is_empty() {
        // A folder with no research history has nothing to preserve, so it
        // must not gain a `.session` archive as a side effect of being removed.
        // The archive write would also recreate a folder the user already
        // deleted from disk, and fail outright on a read-only folder —
        // leaving an *unused* folder impossible to remove.
        state.commit_research_workspace_detach(workspace_id, &archive)?;
        return Ok(detached_tree_ids);
    }
    let mut responses = HashMap::new();
    let archived_nodes_by_id = archive
        .nodes
        .iter()
        .map(|node| (node.id.as_str(), node))
        .collect::<HashMap<_, _>>();
    for node in &archive.nodes {
        let turns =
            match crate::research::read_response_snapshot(&state.config().workspace_root, &node.id)
            {
                Ok(Some(turns)) => Some(turns),
                Ok(None) | Err(_) => {
                    let ancestor_prompts = crate::research::ancestor_prompts(node, |id| {
                        archived_nodes_by_id.get(id).copied()
                    });
                    crate::research::load_transcript_response(
                        state.config(),
                        node,
                        &ancestor_prompts,
                    )
                    .ok()
                }
            };
        if let Some(turns) = turns.filter(|turns| {
            node.status() != crate::research::ResearchNodeStatus::Complete
                || crate::research::has_active_assistant_turn(turns)
        }) {
            responses.insert(node.id.clone(), turns);
        } else if node.post().is_none()
            && node.status() == crate::research::ResearchNodeStatus::Complete
        {
            // Reject detachment only when it would omit a completed exchange's
            // answer or a document's body. Posts store their text in the node
            // record and have no response snapshot. Failed and cancelled runs
            // can also lack a snapshot after the adapter prunes their transcript;
            // their node record preserves the prompt and error, and imports do
            // not require responses for incomplete nodes.
            return Err(format!(
                "research item '{}' has no durable response to detach",
                node.prompt().chars().take(80).collect::<String>()
            ));
        }
    }
    let folder = Path::new(&workspace.dir);
    crate::research::write_detached_research_pending(folder, &archive, &responses)?;
    let image_ids = archive
        .nodes
        .iter()
        .flat_map(|node| crate::research_images::image_ids(node.attachments()))
        .collect::<std::collections::BTreeSet<_>>();
    let images = image_ids
        .into_iter()
        .filter_map(|id| {
            let path = crate::research_images::image_path(&state.config().workspace_root, id)?;
            Some((id.to_string(), path))
        })
        .collect::<Vec<_>>();
    crate::research::write_detached_research_images(folder, &images)?;
    let node_ids = state.commit_research_workspace_detach(workspace_id, &archive)?;
    // The pending archive is already complete and importable. Promotion is the
    // second phase; if it fails, reopening the folder deliberately recovers it.
    if let Err(err) = crate::research::commit_detached_research(folder) {
        // The verified pending form is intentionally importable: after the
        // global commit there is no data-loss reason to report removal as a
        // failure merely because the final directory rename did not complete.
        eprintln!("session: detached research remains in recoverable pending form: {err}");
    }
    for node_id in node_ids {
        if let Err(err) =
            crate::research::remove_response_snapshot(&state.config().workspace_root, &node_id)
        {
            eprintln!("session: failed to remove detached global response {node_id}: {err}");
        }
    }
    Ok(detached_tree_ids)
}

fn require_research_workspace(state: &AppState, workspace_id: &str) -> Result<GroupInfo, String> {
    let workspace = state
        .group(workspace_id)?
        .ok_or_else(|| format!("research workspace {workspace_id} was not found"))?;
    if workspace.scope != WorkspaceScope::Research {
        return Err(format!("workspace {workspace_id} is not Research-scoped"));
    }
    Ok(workspace)
}

fn create_scoped_group(
    state: &AppState,
    request: CreateGroupRequest,
    scope: WorkspaceScope,
) -> Result<GroupInfo, String> {
    let after_group_id = request.after_group_id.clone();
    let group = create_group_record(state, request, scope)?;
    state.insert_group_after(group.clone(), after_group_id.as_deref())?;
    state.emit(crate::events::SessionEvent::new(
        "group.created",
        None,
        None,
        serde_json::json!({ "group": group.clone() }),
    ));
    Ok(group)
}

/// Allocates a group record without inserting it into AppState. Startup
/// migration uses this to construct scoped workspace records before the
/// persisted model is hydrated.
pub(crate) fn create_group_record(
    state: &AppState,
    request: CreateGroupRequest,
    scope: WorkspaceScope,
) -> Result<GroupInfo, String> {
    let id = state.next_id("group");
    let dir = match request.dir.as_deref() {
        Some(dir) => canonical_dir(dir)?,
        None => state.default_open_dir(),
    };
    let generated_name = group_name_for_dir(&dir);
    let name_override = request
        .name
        .clone()
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty());
    let display_name = name_override
        .clone()
        .unwrap_or_else(|| generated_name.clone());
    let managed_dir = unique_group_dir(&state.config().workspace_root, &display_name)?;
    Ok(GroupInfo {
        id,
        name: generated_name,
        name_override,
        dir: dir.display().to_string(),
        managed_dir: managed_dir.display().to_string(),
        base_repo: request.base_repo,
        created_at: now_millis(),
        scope,
        imported_research_archive_id: None,
        agents: Vec::new(),
    })
}

/// Creates a distinct scoped record from a legacy group without requiring its
/// working directory to still exist. Historical research remains viewable even
/// when its original project was moved; a later launch can surface that missing
/// directory and let the user choose a replacement deliberately.
pub(crate) fn clone_group_record_for_scope(
    state: &AppState,
    source: &GroupInfo,
    scope: WorkspaceScope,
) -> Result<GroupInfo, String> {
    let display_name = format!(
        "{} Research",
        source.name_override.as_deref().unwrap_or(&source.name)
    );
    let managed_dir = unique_group_dir(&state.config().workspace_root, &display_name)?;
    Ok(GroupInfo {
        id: state.next_id("group"),
        name: source.name.clone(),
        name_override: Some(display_name),
        dir: source.dir.clone(),
        managed_dir: managed_dir.display().to_string(),
        base_repo: source.base_repo.clone(),
        created_at: now_millis(),
        scope,
        imported_research_archive_id: None,
        // A research clone starts with no agents of its own.
        agents: Vec::new(),
    })
}

fn rename_group_record(
    state: &AppState,
    mut group: GroupInfo,
    name: Option<String>,
) -> Result<GroupInfo, String> {
    group.name_override = name
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty());
    state.update_group(group.clone())?;
    state.emit(crate::events::SessionEvent::new(
        "group.updated",
        None,
        None,
        serde_json::json!({ "group": group.clone() }),
    ));
    Ok(group)
}

pub fn prepare_agent_workspace(
    state: &AppState,
    request: PrepareAgentWorkspaceRequest,
) -> Result<AgentInfo, String> {
    let _guard = AGENT_WORKSPACE_CREATION_LOCK
        .lock()
        .map_err(|_| "agent workspace creation lock poisoned".to_string())?;
    prepare_agent_workspace_locked(state, request)
}

fn prepare_agent_workspace_locked(
    state: &AppState,
    request: PrepareAgentWorkspaceRequest,
) -> Result<AgentInfo, String> {
    let mut group = state
        .group(&request.group_id)?
        .ok_or_else(|| format!("group {} was not found", request.group_id))?;

    let agent_id = state.next_id("agent");
    // An agent runs directly in its explicit base_repo, else the group's
    // base_repo hint, else the group's directory.
    let worktree_dir = request
        .base_repo
        .or_else(|| group.base_repo.clone())
        .unwrap_or_else(|| group.dir.clone());

    let agent = AgentInfo {
        id: agent_id.clone(),
        group_id: group.id.clone(),
        adapter: request.adapter,
        worktree_dir,
        session_id: None,
        transcript_path: None,
        status: AgentStatus::Starting,
        model: request.model,
        effort: request.effort,
        thread_id: Some(state.next_id("thread")),
        branch_id: Some(state.next_id("branch")),
        created_at: now_millis(),
        pane_id: None,
    };

    group.agents.push(agent_id);
    state.update_group(group)?;
    state.insert_agent(agent.clone())?;
    Ok(agent)
}

fn canonical_dir(path: &str) -> Result<PathBuf, String> {
    let canonical =
        fs::canonicalize(path).map_err(|err| format!("failed to resolve {path}: {err}"))?;
    if !canonical.is_dir() {
        return Err(format!("{} is not a directory", canonical.display()));
    }
    Ok(canonical)
}

fn group_name_for_dir(dir: &Path) -> String {
    dir.file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.trim().is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(|| {
            if dir.parent().is_none() {
                "Root".to_string()
            } else {
                default_group_name()
            }
        })
}

/// A friendly, human-readable name for a new group / worktree, e.g.
/// "brave-otter" (two hyphenated words). Falls back to a timestamped name only
/// if generation somehow yields nothing, which the bundled word lists make
/// unreachable in practice.
fn default_group_name() -> String {
    names::Generator::default()
        .next()
        .unwrap_or_else(|| format!("group-{}", now_millis()))
}

/// The `managed_dir` path of a new group: a name under the workspace root no
/// file or directory has yet. It is not created.
fn unique_group_dir(root: &Path, requested_name: &str) -> Result<PathBuf, String> {
    unique_dir(root, requested_name, "group")
}

fn unique_dir(root: &Path, requested_name: &str, kind: &str) -> Result<PathBuf, String> {
    let base = sanitize_path_segment(requested_name);
    for index in 0..1000 {
        let name = if index == 0 {
            base.clone()
        } else {
            format!("{base}-{index}")
        };
        let candidate = root.join(name);
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err(format!(
        "failed to allocate a unique {kind} directory under {}",
        root.display()
    ))
}

fn sanitize_path_segment(value: &str) -> String {
    let sanitized = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string();

    if sanitized.is_empty() {
        default_group_name()
    } else {
        sanitized
    }
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{
        AdapterConfigs, ClaudeAdapterConfig, CodexAdapterConfig, GrokAdapterConfig, SessionConfig,
    };
    use crate::persistence;

    fn test_state_with_workspace(workspace_root: PathBuf) -> AppState {
        std::fs::create_dir_all(&workspace_root).unwrap();
        let socket_path = workspace_root.join("session.sock");
        AppState::new(SessionConfig {
            workspace_root,
            socket_path,
            adapters: AdapterConfigs {
                claude: ClaudeAdapterConfig {
                    binary: Some("claude".to_string()),
                },
                codex: CodexAdapterConfig {
                    binary: Some("codex".to_string()),
                },
                grok: GrokAdapterConfig {
                    binary: Some("grok".to_string()),
                },
            },
            legacy_claude_binary: None,
        })
    }

    fn temp_workspace(prefix: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let dir = std::env::temp_dir().join(format!("session-workspace-{prefix}-{nanos}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn sample_agent(id: &str, pane_id: Option<&str>, status: AgentStatus) -> AgentInfo {
        AgentInfo {
            id: id.to_string(),
            group_id: "group-1".to_string(),
            adapter: "claude".to_string(),
            worktree_dir: "/tmp/session-workspace-tests".to_string(),
            pane_id: pane_id.map(ToString::to_string),
            session_id: None,
            transcript_path: None,
            status,
            model: None,
            effort: None,
            thread_id: None,
            branch_id: None,
            created_at: 1,
        }
    }

    #[test]
    fn default_research_workspace_is_scoped_persistent_and_idempotent() {
        let root = std::env::temp_dir().join(format!("session-default-research-{}", now_millis()));
        let state = test_state_with_workspace(root.clone());

        let first = ensure_default_research_workspace(&state).unwrap();
        let second = ensure_default_research_workspace(&state).unwrap();

        assert_eq!(first.id, second.id);
        assert_eq!(first.scope, WorkspaceScope::Research);
        assert_eq!(first.name_override.as_deref(), Some("Default workspace"));
        assert_eq!(
            std::fs::canonicalize(&first.dir).unwrap(),
            std::fs::canonicalize(state.default_research_dir()).unwrap()
        );
        assert!(Path::new(&first.dir).is_dir());
        assert_eq!(state.list_research_workspaces().unwrap().len(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn chosen_research_workspace_reuses_the_same_directory() {
        let root = temp_workspace("chosen-research");
        let chosen = root.join("project");
        std::fs::create_dir_all(&chosen).unwrap();
        let state = test_state_with_workspace(root.join("managed"));

        let first =
            create_research_workspace(&state, None, chosen.to_string_lossy().into_owned()).unwrap();
        let second = create_research_workspace(
            &state,
            Some("Duplicate".to_string()),
            chosen.to_string_lossy().into_owned(),
        )
        .unwrap();

        assert_eq!(first.id, second.id);
        assert_eq!(state.list_research_workspaces().unwrap().len(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn concurrent_research_workspace_creation_converges_on_one_directory() {
        let root = temp_workspace("concurrent-research");
        let chosen = root.join("project");
        std::fs::create_dir_all(&chosen).unwrap();
        let state = std::sync::Arc::new(test_state_with_workspace(root.join("managed")));
        let mut workers = Vec::new();
        for _ in 0..4 {
            let state = state.clone();
            let chosen = chosen.clone();
            workers.push(std::thread::spawn(move || {
                create_research_workspace(&state, None, chosen.display().to_string())
                    .unwrap()
                    .id
            }));
        }
        let ids = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect::<std::collections::HashSet<_>>();
        assert_eq!(ids.len(), 1);
        assert_eq!(state.list_research_workspaces().unwrap().len(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }

    /// A post has no response snapshot or run and is treated as complete. It
    /// must not prevent removal of its folder.
    #[test]
    fn removing_a_research_folder_with_a_post_detaches_and_restores_it() {
        let root = temp_workspace("remove-post-research");
        let project = root.join("project");
        std::fs::create_dir_all(&project).unwrap();
        let state = test_state_with_workspace(root.join("managed"));
        state.restore_session();
        let workspace =
            create_research_workspace(&state, None, project.display().to_string()).unwrap();
        state
            .create_research_post(
                crate::research::CreateResearchPostRequest {
                    body: "Who has tried X?".to_string(),
                    adapter: "claude".to_string(),
                    model: None,
                    effort: None,
                    workspace_id: workspace.id.clone(),
                },
                Vec::new(),
            )
            .unwrap();

        let detached = remove_research_workspace(&state, &workspace.id).unwrap();

        assert_eq!(detached.len(), 1);
        assert!(state.group(&workspace.id).unwrap().is_none());
        let archive = crate::research::read_detached_research(&project)
            .unwrap()
            .expect("detached archive");
        assert_eq!(archive.archive.nodes.len(), 1);
        assert!(archive.responses.is_empty());

        let restored =
            create_research_workspace(&state, None, project.display().to_string()).unwrap();
        assert_ne!(restored.id, workspace.id);
        let restored_trees = state.list_research_trees_with_archived(true).unwrap();
        assert_eq!(restored_trees.len(), 1);
        let restored_detail = state.research_tree(&restored_trees[0].id).unwrap();
        let post = restored_detail.nodes[0].post().expect("a post");
        assert_eq!(post.message.text, "Who has tried X?");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn removed_research_folders_carry_their_images() {
        let root = temp_workspace("remove-images-research");
        let project = root.join("project");
        let moved = root.join("moved");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(&moved).unwrap();
        let managed = root.join("managed");
        let state = test_state_with_workspace(managed.clone());
        state.restore_session();
        let workspace =
            create_research_workspace(&state, None, project.display().to_string()).unwrap();
        let png = b"\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR\0\0\0\x02\0\0\0\x02\x08\x06\0\0\0".to_vec();
        let image = crate::research_images::save_pending(&managed, &png, None).unwrap();
        let crate::tweets::ResearchMessageAttachment::Image { id, .. } = &image else {
            panic!("expected an image attachment");
        };
        let id = id.clone();
        state
            .create_research_post(
                crate::research::CreateResearchPostRequest {
                    body: "What is in this picture?".to_string(),
                    adapter: "claude".to_string(),
                    model: None,
                    effort: None,
                    workspace_id: workspace.id.clone(),
                },
                vec![image],
            )
            .unwrap();

        // The folder's drafts are not carried; their images are released.
        let draft_image = crate::research_images::save_pending(&managed, &png, None).unwrap();
        let crate::tweets::ResearchMessageAttachment::Image { id: draft_id, .. } = &draft_image
        else {
            panic!("expected an image attachment");
        };
        let draft_id = draft_id.clone();
        state
            .save_research_draft_with_images(
                None,
                &workspace.id,
                "Draft".to_string(),
                Some(vec![draft_image]),
            )
            .unwrap();
        let store = crate::research_images::store_dir(&managed);
        assert!(store.join(&draft_id).is_file());

        remove_research_workspace(&state, &workspace.id).unwrap();
        assert!(!store.join(&draft_id).exists());
        assert!(store.join("pending").join(&draft_id).is_file());
        let bundle = crate::research::read_detached_research(&project)
            .unwrap()
            .expect("detached archive");
        assert_eq!(bundle.archive.version, 14);
        assert_eq!(bundle.images.len(), 1);
        assert_eq!(bundle.images[0].0, id);
        assert_eq!(std::fs::read(&bundle.images[0].1).unwrap(), png);

        // The archive moves with the folder, images included, and restores
        // them on a machine whose store does not have them.
        std::fs::rename(project.join(".session"), moved.join(".session")).unwrap();
        for path in [
            crate::research_images::store_dir(&managed).join(&id),
            crate::research_images::store_dir(&managed)
                .join("pending")
                .join(&id),
        ] {
            let _ = std::fs::remove_file(path);
        }
        assert!(crate::research_images::image_path(&managed, &id).is_none());
        create_research_workspace(&state, None, moved.display().to_string()).unwrap();
        assert_eq!(
            crate::research_images::image_path(&managed, &id),
            Some(crate::research_images::store_dir(&managed).join(&id))
        );
        assert_eq!(
            std::fs::read(crate::research_images::store_dir(&managed).join(&id)).unwrap(),
            png
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn removing_unused_research_folder_writes_nothing_into_it() {
        let root = temp_workspace("remove-empty-research");
        let project = root.join("project");
        std::fs::create_dir_all(&project).unwrap();
        let state = test_state_with_workspace(root.join("managed"));
        state.restore_session();
        let workspace =
            create_research_workspace(&state, None, project.display().to_string()).unwrap();
        // Removal of a folder that never ran research must succeed even when
        // the folder itself cannot be written to.
        std::fs::set_permissions(&project, std::fs::Permissions::from_mode(0o555)).unwrap();

        let detached = remove_research_workspace(&state, &workspace.id).unwrap();

        std::fs::set_permissions(&project, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(detached.is_empty());
        assert!(state.group(&workspace.id).unwrap().is_none());
        assert!(!project.join(crate::persistence::STATE_DIR).exists());
        assert!(
            crate::research::read_detached_research(&project)
                .unwrap()
                .is_none()
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn removing_research_folder_survives_failed_run_with_pruned_transcript() {
        let root = temp_workspace("remove-research-pruned-transcript");
        let project = root.join("project");
        std::fs::create_dir_all(&project).unwrap();
        let state = test_state_with_workspace(root.join("managed"));
        state.restore_session();
        let workspace =
            create_research_workspace(&state, None, project.display().to_string()).unwrap();
        let detail = state
            .create_research_tree(crate::research::CreateResearchTreeRequest {
                prompt: "Doomed question".to_string(),
                title: None,
                adapter: "claude".to_string(),
                model: None,
                effort: None,
                group_id: workspace.id.clone(),
            })
            .unwrap();
        // A run that failed and whose adapter transcript has since been
        // pruned from disk: the node keeps a transcript_path that no longer
        // resolves to anything readable.
        let mut agent = sample_agent("research-agent", None, AgentStatus::Failed);
        agent.group_id = workspace.id.clone();
        agent.transcript_path = Some(root.join("pruned/session-gone.jsonl").display().to_string());
        state
            .bind_research_node_run(&detail.tree.root_node_id, &agent)
            .unwrap();
        let node = state.research_node(&detail.tree.root_node_id).unwrap();
        assert_eq!(node.status(), crate::research::ResearchNodeStatus::Failed);
        assert!(node.binding().unwrap().transcript_path.is_some());

        remove_research_workspace(&state, &workspace.id).unwrap();

        assert!(state.group(&workspace.id).unwrap().is_none());
        let archive = crate::research::read_detached_research(&project)
            .unwrap()
            .expect("detached archive");
        assert_eq!(archive.archive.nodes.len(), 1);
        assert!(archive.responses.is_empty());

        // The node record itself (prompt, failure) still restores on reopen.
        let restored =
            create_research_workspace(&state, None, project.display().to_string()).unwrap();
        assert_ne!(restored.id, workspace.id);
        let restored_trees = state.list_research_trees_with_archived(true).unwrap();
        assert_eq!(restored_trees.len(), 1);
        let restored_detail = state.research_tree(&restored_trees[0].id).unwrap();
        assert_eq!(
            restored_detail.nodes[0].status(),
            crate::research::ResearchNodeStatus::Failed
        );
        assert_eq!(restored_detail.nodes[0].prompt(), "Doomed question");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reopening_folder_with_missing_archive_response_still_imports_history() {
        let root = temp_workspace("reopen-damaged-archive");
        let project = root.join("project");
        std::fs::create_dir_all(&project).unwrap();
        let state = test_state_with_workspace(root.join("managed"));
        state.restore_session();
        let workspace =
            create_research_workspace(&state, None, project.display().to_string()).unwrap();
        let detail = state
            .create_research_tree(crate::research::CreateResearchTreeRequest {
                prompt: "Answered question".to_string(),
                title: None,
                adapter: "claude".to_string(),
                model: None,
                effort: None,
                group_id: workspace.id.clone(),
            })
            .unwrap();
        let mut agent = sample_agent("research-agent", None, AgentStatus::Done);
        agent.group_id = workspace.id.clone();
        state
            .bind_research_node_run(&detail.tree.root_node_id, &agent)
            .unwrap();
        let node_id = detail.tree.root_node_id.clone();
        assert_eq!(
            state.research_node(&node_id).unwrap().status(),
            crate::research::ResearchNodeStatus::Complete
        );
        crate::research::write_response_snapshot(
            &state.config().workspace_root,
            &node_id,
            &[crate::transcript::Turn {
                id: "answer-1".to_string(),
                agent_id: "research-agent".to_string(),
                session_id: None,
                role: "assistant".to_string(),
                blocks: vec![crate::transcript::TurnBlock::Text {
                    text: "The answer".to_string(),
                }],
                source_index: 0,
                timestamp: None,
                status: None,
                status_reason: None,
                context_status: None,
                native_id: None,
                parent_native_id: None,
                native_message_id: None,
            }],
        )
        .unwrap();
        remove_research_workspace(&state, &workspace.id).unwrap();

        // A normally-detached Complete node carries its snapshot stamp; the
        // helper-written snapshot above bypassed the stamping path, so stamp
        // the archived record the way a real run would have.
        let manifest_path = project
            .join(crate::persistence::STATE_DIR)
            .join("research-v1/manifest.json");
        let mut manifest: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&manifest_path).unwrap()).unwrap();
        manifest["nodes"][0]["responseSnapshotAt"] = serde_json::json!(2);
        std::fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();

        // Simulate the archive losing the response file outside Session — a
        // partial copy between machines, or a hand-deleted file.
        let response_file = project
            .join(crate::persistence::STATE_DIR)
            .join("research-v1/responses")
            .join(format!("{node_id}.json"));
        std::fs::remove_file(&response_file).unwrap();

        let restored =
            create_research_workspace(&state, None, project.display().to_string()).unwrap();

        let restored_trees = state.list_research_trees_with_archived(true).unwrap();
        assert_eq!(restored_trees.len(), 1);
        let restored_detail = state.research_tree(&restored_trees[0].id).unwrap();
        let restored_node = &restored_detail.nodes[0];
        assert_eq!(restored_node.group_id, restored.id);
        assert_eq!(
            restored_node.status(),
            crate::research::ResearchNodeStatus::Complete
        );
        // The node must not claim a durable answer it no longer has.
        assert!(restored_node.response_snapshot_at().is_none());
        assert!(
            crate::research::read_response_snapshot(
                &state.config().workspace_root,
                &restored_node.id,
            )
            .unwrap()
            .is_none()
        );
        // The consumed archive is cleaned up like any successful import.
        assert!(
            crate::research::read_detached_research(&project)
                .unwrap()
                .is_none()
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    fn sample_detached_manifest(folder: &Path) -> crate::research::DetachedResearchArchive {
        crate::research::DetachedResearchArchive {
            version: crate::research::DETACHED_RESEARCH_ARCHIVE_VERSION,
            archive_id: "archive-test".to_string(),
            workspace: GroupInfo {
                id: "group-detached".to_string(),
                name: "project".to_string(),
                name_override: None,
                dir: folder.display().to_string(),
                managed_dir: String::new(),
                base_repo: None,
                created_at: 1,
                scope: WorkspaceScope::Research,
                imported_research_archive_id: None,
                agents: Vec::new(),
            },
            trees: Vec::new(),
            tree_order: Vec::new(),
            folders: Vec::new(),
            membership: std::collections::HashMap::new(),
            parents: std::collections::HashMap::new(),
            nodes: Vec::new(),
            exported_at: 1,
        }
    }

    #[test]
    fn opening_folder_with_unreadable_archive_names_the_archive_and_a_way_out() {
        let root = temp_workspace("open-unreadable-archive");
        let project = root.join("project");
        let archive_dir = project
            .join(crate::persistence::STATE_DIR)
            .join("research-v1");
        std::fs::create_dir_all(&archive_dir).unwrap();
        std::fs::write(archive_dir.join("manifest.json"), b"{ not json").unwrap();
        let state = test_state_with_workspace(root.join("managed"));
        state.restore_session();

        let error =
            create_research_workspace(&state, None, project.display().to_string()).unwrap_err();

        assert!(
            error.contains(&archive_dir.display().to_string()),
            "{error}"
        );
        assert!(error.contains("move"), "{error}");

        // An archive from a newer Session gets the same actionable framing plus
        // the version hint.
        let mut manifest = serde_json::to_value(sample_detached_manifest(&project)).unwrap();
        manifest["version"] = serde_json::json!(999);
        std::fs::write(
            archive_dir.join("manifest.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        let error =
            create_research_workspace(&state, None, project.display().to_string()).unwrap_err();
        assert!(error.contains("newer session"), "{error}");
        assert!(
            error.contains(&archive_dir.display().to_string()),
            "{error}"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn moving_research_folder_repoints_record_and_leaves_both_folders_intact() {
        let root = temp_workspace("move-research");
        let source = root.join("source/project");
        let destination = root.join("destination/notes");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::create_dir_all(&destination).unwrap();
        std::fs::write(source.join("draft.md"), "user content").unwrap();
        std::fs::write(destination.join("existing.md"), "already here").unwrap();
        let state = test_state_with_workspace(root.join("managed"));
        state.restore_session();
        let workspace =
            create_research_workspace(&state, None, source.display().to_string()).unwrap();
        rename_research_workspace(&state, &workspace.id, Some("My research".to_string())).unwrap();
        let detail = state
            .create_research_tree(crate::research::CreateResearchTreeRequest {
                prompt: "Question".to_string(),
                title: None,
                adapter: "claude".to_string(),
                model: None,
                effort: None,
                group_id: workspace.id.clone(),
            })
            .unwrap();

        assert!(
            move_research_workspace(&state, &workspace.id, destination.display().to_string())
                .unwrap_err()
                .contains("active runs")
        );
        state
            .fail_research_node(&detail.tree.root_node_id, "settled".to_string())
            .unwrap();

        let moved =
            move_research_workspace(&state, &workspace.id, destination.display().to_string())
                .unwrap();

        let canonical_destination = std::fs::canonicalize(&destination).unwrap();
        assert_eq!(moved.dir, canonical_destination.display().to_string());
        assert_eq!(moved.name, "notes");
        assert_eq!(moved.name_override.as_deref(), Some("My research"));
        // The history never left global state; only the record moved.
        assert_eq!(
            state.list_research_trees_with_archived(true).unwrap().len(),
            1
        );
        let node = state.research_node(&detail.tree.root_node_id).unwrap();
        assert_eq!(
            node.binding().unwrap().worktree_dir,
            std::fs::canonicalize(&source)
                .unwrap()
                .display()
                .to_string()
        );
        // Neither folder gains or loses anything: no `.session` appears, the
        // source keeps its contents, and the destination keeps its own.
        assert!(source.join("draft.md").is_file());
        assert!(!source.join(crate::persistence::STATE_DIR).exists());
        assert!(destination.join("existing.md").is_file());
        assert!(!destination.join(crate::persistence::STATE_DIR).exists());
        // The repoint is durable.
        let persisted = persistence::load_with_diagnostics(&state.config().workspace_root).state;
        let persisted_group = persisted
            .groups
            .iter()
            .find(|group| group.id == workspace.id)
            .expect("moved workspace persisted");
        assert_eq!(persisted_group.dir, moved.dir);
        // Moving to the directory it already occupies is a no-op.
        let unchanged =
            move_research_workspace(&state, &workspace.id, destination.display().to_string())
                .unwrap();
        assert_eq!(unchanged.dir, moved.dir);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn moving_research_folder_refuses_occupied_or_history_bearing_destinations() {
        let root = temp_workspace("move-research-refusals");
        let source = root.join("project");
        let occupied = root.join("occupied");
        let with_history = root.join("with-history");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::create_dir_all(&occupied).unwrap();
        std::fs::create_dir_all(&with_history).unwrap();
        let state = test_state_with_workspace(root.join("managed"));
        state.restore_session();
        let workspace =
            create_research_workspace(&state, None, source.display().to_string()).unwrap();
        create_research_workspace(&state, None, occupied.display().to_string()).unwrap();
        // A folder that carries another workspace's detached history: run a
        // real detach into it.
        let removed_workspace =
            create_research_workspace(&state, None, with_history.display().to_string()).unwrap();
        let removed_detail = state
            .create_research_tree(crate::research::CreateResearchTreeRequest {
                prompt: "Detached question".to_string(),
                title: None,
                adapter: "claude".to_string(),
                model: None,
                effort: None,
                group_id: removed_workspace.id.clone(),
            })
            .unwrap();
        state
            .fail_research_node(&removed_detail.tree.root_node_id, "settled".to_string())
            .unwrap();
        remove_research_workspace(&state, &removed_workspace.id).unwrap();
        assert!(
            crate::research::read_detached_research(&with_history)
                .unwrap()
                .is_some()
        );

        assert!(
            move_research_workspace(&state, &workspace.id, occupied.display().to_string())
                .unwrap_err()
                .contains("already open as research folder")
        );
        assert!(
            move_research_workspace(&state, &workspace.id, with_history.display().to_string())
                .unwrap_err()
                .contains("detached research history")
        );
        // The refused moves changed nothing: the record still points at the
        // source and the foreign archive is untouched.
        let unchanged = state.group(&workspace.id).unwrap().unwrap();
        assert_eq!(unchanged.dir, workspace.dir);
        assert!(
            crate::research::read_detached_research(&with_history)
                .unwrap()
                .is_some()
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn moving_research_folder_carries_its_own_pending_archive() {
        let root = temp_workspace("move-research-pending");
        let source = root.join("project");
        let destination = root.join("elsewhere");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::create_dir_all(&destination).unwrap();
        let state = test_state_with_workspace(root.join("managed"));
        state.restore_session();
        let workspace =
            create_research_workspace(&state, None, source.display().to_string()).unwrap();
        let detail = state
            .create_research_tree(crate::research::CreateResearchTreeRequest {
                prompt: "Question".to_string(),
                title: None,
                adapter: "claude".to_string(),
                model: None,
                effort: None,
                group_id: workspace.id.clone(),
            })
            .unwrap();
        state
            .fail_research_node(&detail.tree.root_node_id, "settled".to_string())
            .unwrap();
        // A removal interrupted before its global commit leaves the
        // workspace's own archive in pending form.
        let own_archive = state.detached_research_archive(&workspace.id).unwrap();
        crate::research::write_detached_research_pending(
            &source,
            &own_archive,
            &std::collections::HashMap::new(),
        )
        .unwrap();

        let moved =
            move_research_workspace(&state, &workspace.id, destination.display().to_string())
                .unwrap();

        // The pending archive traveled with the workspace, still pending —
        // never promoted, so a retried removal can still replace it.
        let carried = crate::research::read_detached_research(&destination)
            .unwrap()
            .expect("archive at destination");
        assert!(carried.pending);
        assert_eq!(carried.archive.workspace.id, workspace.id);
        assert!(
            crate::research::read_detached_research(&source)
                .unwrap()
                .is_none()
        );
        assert_eq!(
            moved.dir,
            std::fs::canonicalize(&destination)
                .unwrap()
                .display()
                .to_string()
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn moving_research_folder_leaves_foreign_archives_with_the_old_folder() {
        let root = temp_workspace("move-research-foreign");
        let source = root.join("project");
        let destination = root.join("elsewhere");
        let donor = root.join("donor");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::create_dir_all(&destination).unwrap();
        std::fs::create_dir_all(&donor).unwrap();
        let state = test_state_with_workspace(root.join("managed"));
        state.restore_session();
        let workspace =
            create_research_workspace(&state, None, source.display().to_string()).unwrap();
        // Another workspace's detached history sitting in this folder does
        // not describe this workspace, so a move must not take it along.
        let donor_workspace =
            create_research_workspace(&state, None, donor.display().to_string()).unwrap();
        let donor_detail = state
            .create_research_tree(crate::research::CreateResearchTreeRequest {
                prompt: "Donor question".to_string(),
                title: None,
                adapter: "claude".to_string(),
                model: None,
                effort: None,
                group_id: donor_workspace.id.clone(),
            })
            .unwrap();
        state
            .fail_research_node(&donor_detail.tree.root_node_id, "settled".to_string())
            .unwrap();
        let donor_archive = state
            .detached_research_archive(&donor_workspace.id)
            .unwrap();
        crate::research::write_detached_research_pending(
            &source,
            &donor_archive,
            &std::collections::HashMap::new(),
        )
        .unwrap();

        let moved =
            move_research_workspace(&state, &workspace.id, destination.display().to_string())
                .unwrap();

        assert_eq!(
            moved.dir,
            std::fs::canonicalize(&destination)
                .unwrap()
                .display()
                .to_string()
        );
        let left_behind = crate::research::read_detached_research(&source)
            .unwrap()
            .expect("foreign archive stays with the old folder");
        assert_eq!(left_behind.archive.workspace.id, donor_workspace.id);
        assert!(
            crate::research::read_detached_research(&destination)
                .unwrap()
                .is_none()
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn removing_research_folder_detaches_and_reopening_imports_its_history() {
        let root = temp_workspace("remove-research");
        let project = root.join("project");
        std::fs::create_dir_all(&project).unwrap();
        let state = test_state_with_workspace(root.join("managed"));
        state.restore_session();
        let workspace =
            create_research_workspace(&state, None, project.display().to_string()).unwrap();
        let detail = state
            .create_research_tree(crate::research::CreateResearchTreeRequest {
                prompt: "Question".to_string(),
                title: None,
                adapter: "claude".to_string(),
                model: None,
                effort: None,
                group_id: workspace.id.clone(),
            })
            .unwrap();

        assert!(
            remove_research_workspace(&state, &workspace.id)
                .unwrap_err()
                .contains("active runs")
        );
        state
            .fail_research_node(&detail.tree.root_node_id, "settled".to_string())
            .unwrap();
        crate::research::write_response_snapshot(
            &state.config().workspace_root,
            &detail.tree.root_node_id,
            &[crate::transcript::Turn {
                id: "answer-1".to_string(),
                agent_id: "research-agent".to_string(),
                session_id: None,
                role: "assistant".to_string(),
                blocks: vec![crate::transcript::TurnBlock::Text {
                    text: "Portable answer".to_string(),
                }],
                source_index: 0,
                timestamp: None,
                status: None,
                status_reason: None,
                context_status: None,
                native_id: None,
                parent_native_id: None,
                native_message_id: None,
            }],
        )
        .unwrap();
        remove_research_workspace(&state, &workspace.id).unwrap();
        assert!(state.group(&workspace.id).unwrap().is_none());
        assert!(
            state
                .list_research_trees_with_archived(true)
                .unwrap()
                .is_empty()
        );
        let detached_state =
            persistence::load_with_diagnostics(&state.config().workspace_root).state;
        assert!(
            detached_state
                .groups
                .iter()
                .all(|group| group.id != workspace.id)
        );
        assert!(detached_state.research_trees.is_empty());
        assert!(detached_state.research_nodes.is_empty());
        assert!(
            crate::research::read_response_snapshot(
                &state.config().workspace_root,
                &detail.tree.root_node_id,
            )
            .unwrap()
            .is_none()
        );
        let archive = crate::research::read_detached_research(&project)
            .unwrap()
            .expect("detached archive");
        assert_eq!(archive.archive.trees.len(), 1);
        assert_eq!(archive.archive.nodes.len(), 1);
        assert_eq!(
            archive.responses[&detail.tree.root_node_id][0].id,
            "answer-1"
        );

        // Simulate a crash after the checked global commit but before the
        // pending archive was promoted. Opening the folder must recover this
        // form exactly like the final archive.
        let archive_parent = project.join(crate::persistence::STATE_DIR);
        std::fs::rename(
            archive_parent.join("research-v1"),
            archive_parent.join("research-v1.pending"),
        )
        .unwrap();

        let restored =
            create_research_workspace(&state, None, project.display().to_string()).unwrap();
        assert_ne!(restored.id, workspace.id);
        assert!(restored.imported_research_archive_id.is_none());
        let restored_trees = state.list_research_trees_with_archived(true).unwrap();
        assert_eq!(restored_trees.len(), 1);
        assert_eq!(restored_trees[0].title, detail.tree.title);
        let restored_detail = state.research_tree(&restored_trees[0].id).unwrap();
        let restored_response = crate::research::read_response_snapshot(
            &state.config().workspace_root,
            &restored_detail.tree.root_node_id,
        )
        .unwrap()
        .expect("restored response");
        assert_eq!(restored_response[0].id, "answer-1");
        let imported_state =
            persistence::load_with_diagnostics(&state.config().workspace_root).state;
        assert_eq!(imported_state.research_trees.len(), 1);
        assert_eq!(imported_state.research_nodes.len(), 1);
        assert!(
            crate::research::read_detached_research(&project)
                .unwrap()
                .is_none()
        );

        // Simulate a crash after the global import committed but before its
        // matching folder archive was deleted. The persisted receipt lets the
        // next startup remove exactly that duplicate and then retire itself.
        crate::research::write_detached_research_pending(
            &project,
            &archive.archive,
            &archive.responses,
        )
        .unwrap();
        crate::research::commit_detached_research(&project).unwrap();
        let mut cleanup_receipt = restored.clone();
        cleanup_receipt.imported_research_archive_id = Some(archive.archive.archive_id.clone());
        state.update_group(cleanup_receipt).unwrap();
        reconcile_imported_research_archives(&state);
        assert!(
            crate::research::read_detached_research(&project)
                .unwrap()
                .is_none()
        );
        assert!(
            state
                .group(&restored.id)
                .unwrap()
                .unwrap()
                .imported_research_archive_id
                .is_none()
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn research_launch_requires_an_available_research_workspace() {
        let root = temp_workspace("launch-origin");
        let project = root.join("project");
        std::fs::create_dir_all(&project).unwrap();
        let state = test_state_with_workspace(root.join("managed"));
        let research =
            create_research_workspace(&state, None, project.display().to_string()).unwrap();
        assert!(validate_launch_workspace(&state, &research.id).is_ok());
        assert!(
            validate_launch_workspace(&state, "missing")
                .unwrap_err()
                .contains("was not found")
        );
        std::fs::remove_dir_all(&project).unwrap();
        assert!(
            validate_launch_workspace(&state, &research.id)
                .unwrap_err()
                .contains("unavailable")
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn stopped_status_deserializes_as_idle() {
        let status: AgentStatus = serde_json::from_str("\"stopped\"").unwrap();
        assert!(matches!(status, AgentStatus::Idle));
    }

    #[test]
    fn default_group_name_is_a_human_readable_hyphenated_name() {
        // Sample several times since generation is random.
        for _ in 0..50 {
            let name = default_group_name();
            let words: Vec<&str> = name.split('-').collect();
            // Hyphenated words (typically two: adjective-noun), each a non-empty
            // run of lowercase letters — not the old "group-<millis>" form.
            assert!(words.len() >= 2, "expected a hyphenated name, got {name:?}");
            assert!(
                words
                    .iter()
                    .all(|word| !word.is_empty() && word.chars().all(|ch| ch.is_ascii_lowercase())),
                "unexpected friendly name {name:?}"
            );
            assert!(
                !name.starts_with("group-"),
                "name should not use the group- prefix: {name:?}"
            );
        }
    }
}
