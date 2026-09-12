use crate::adapters::adapter_registry;
use crate::pty::respawn_shell_pane;
use crate::scrollback::append_pane_scrollback;
use crate::state::{AppState, PaneInfo, PaneKind};

/// Restores the last explicitly closed pane from its persisted snapshot.
pub fn restore_last_closed_pane(state: &AppState) -> Result<Option<PaneInfo>, String> {
    let Some(mut snapshot) = state.take_last_closed_pane()? else {
        return Ok(None);
    };
    snapshot.pane.id = state.next_id("pane");

    match restore_closed_pane_snapshot(state, &snapshot) {
        Ok(pane) => Ok(Some(pane)),
        Err(err) => {
            let _ = state.remember_last_closed_pane(snapshot);
            Err(err)
        }
    }
}

fn restore_closed_pane_snapshot(
    state: &AppState,
    snapshot: &crate::state::ClosedPaneSnapshot,
) -> Result<PaneInfo, String> {
    state.restore_closed_pane_metadata(snapshot)?;

    match snapshot.pane.kind {
        PaneKind::Shell => {
            respawn_shell_pane(state, &snapshot.pane)?;
        }
        PaneKind::Agent => {
            let agent = snapshot
                .agent
                .as_ref()
                .ok_or_else(|| {
                    format!(
                        "closed agent pane {} is missing its agent",
                        snapshot.pane.id
                    )
                })?
                .agent
                .clone();
            adapter_registry(state.config())
                .get(&agent.adapter)?
                .resume(state, &snapshot.pane, &agent)?;
        }
    }

    if !snapshot.scrollback.is_empty()
        && let Err(err) = append_pane_scrollback(
            &state.config().workspace_root,
            &snapshot.pane.id,
            &snapshot.scrollback,
        )
    {
        eprintln!(
            "qmux: failed to restore scrollback for pane {}: {err}",
            snapshot.pane.id
        );
    }

    state.set_pane_recovered(&snapshot.pane.id, false)?;
    let panes = state.place_restored_pane(&snapshot.pane.id, snapshot.index)?;
    panes
        .into_iter()
        .find(|pane| pane.id == snapshot.pane.id)
        .ok_or_else(|| format!("restored pane {} was not found", snapshot.pane.id))
}
