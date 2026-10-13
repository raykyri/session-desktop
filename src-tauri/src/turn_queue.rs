use crate::adapters::{agent_composer_policy, fork_agent_source, spawn_sibling_agent_session};
use crate::events::SessionEvent;
use crate::pty::{PaneWriteOptions, write_pane, write_pane_detailed};
use crate::state::{
    AgentSendSource, AgentTurnClaim, AppState, IdleAdvance, QueuedTurn, QueuedTurnDelivery,
    SubmitWatchStatus,
};
use crate::workspace::{AgentInfo, AgentStatus};
use serde_json::json;
use std::collections::{HashSet, VecDeque};

/// Turns the agent TUI intercepts as commands rather than plain prompts: `!` shell
/// escapes and `/` slash commands. Built-in slash commands (e.g. Claude's `/model`)
/// fire no hooks at all — no UserPromptSubmit and no Stop/idle — so a send must not
/// optimistically mark the agent Running on their behalf; nothing would ever mark it
/// idle again. Slash commands that do start a real turn (skills) still promote the
/// agent to Running through their own UserPromptSubmit/PreToolUse hooks moments
/// later.
pub(crate) fn is_tui_command_turn(text: &str) -> bool {
    let trimmed = text.trim_start();
    trimmed.starts_with('!') || trimmed.starts_with('/')
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum QueuedComposerCommand<'a> {
    Fork { prompt: &'a str, use_worktree: bool },
}

/// Recognizes Session composer commands only at byte zero, with the same exact-token
/// and space/tab separator rules as the frontend parser. Delaying this until a
/// queued turn is claimed means edits, reorders, moves, and restored queues all
/// dispatch from the text the user can actually see.
fn parse_queued_composer_command(text: &str) -> Option<QueuedComposerCommand<'_>> {
    fn prompt_after<'a>(text: &'a str, token: &str) -> Option<&'a str> {
        let rest = text.strip_prefix(token)?;
        if !matches!(rest.chars().next(), Some(' ' | '\t')) {
            return None;
        }
        let prompt = rest.trim();
        (!prompt.is_empty()).then_some(prompt)
    }

    if let Some(prompt) = prompt_after(text, "/fork") {
        return Some(QueuedComposerCommand::Fork {
            prompt,
            use_worktree: false,
        });
    }
    if let Some(prompt) = prompt_after(text, "/worktree") {
        return Some(QueuedComposerCommand::Fork {
            prompt,
            use_worktree: true,
        });
    }
    None
}

/// Drains the agent's queue: dispatches ready turns until one runs on the agent
/// itself, the queue empties or blocks, or a pause is requested. Returns whether the agent is
/// now running a turn of its own — delivery turns dispatched along the way go to
/// new panes and leave it idle, so they don't count, keeping callers'
/// `agent.running` emissions and `sent` flags accurate.
pub fn drain_agent_turn_queue(state: &AppState, agent_id: &str) -> Result<bool, String> {
    let result = drain_agent_turn_queue_inner(state, agent_id)?;
    if result.completed_idle_delivery {
        // Delivery turns can resolve agents without a later Stop hook. Wake their
        // dependents through the iterative release path below rather than recursively
        // entering another public drain for every edge in a long wait chain.
        release_waiters_for_agent(state, agent_id)?;
    }
    Ok(result.source_running)
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct DrainAgentTurnQueueResult {
    source_running: bool,
    completed_idle_delivery: bool,
}

/// Drain implementation used by waiter release. It reports an idle delivery
/// completion to its caller but never wakes waiters itself, which keeps dependency
/// chains on the heap-backed worklist in `release_waiters_for_agent` instead of the
/// call stack.
fn drain_agent_turn_queue_inner(
    state: &AppState,
    agent_id: &str,
) -> Result<DrainAgentTurnQueueResult, String> {
    let mut completed_idle_delivery = false;
    loop {
        // Claim under the model lock so two concurrent triggers can't each pop a ready
        // turn and double-send (the agent isn't marked Running until the send below).
        match state.claim_ready_agent_turn(agent_id)? {
            AgentTurnClaim::Ready { turn, pending } => {
                match send_claimed_turn(state, agent_id, turn, pending, true)? {
                    DispatchOutcome::Ran => {
                        return Ok(DrainAgentTurnQueueResult {
                            source_running: true,
                            // The source is busy again, so it has not resolved even if
                            // preceding delivery turns left it idle momentarily.
                            completed_idle_delivery: false,
                        });
                    }
                    DispatchOutcome::ForkPending => {
                        let finish = state.finish_agent_fork_dispatch(agent_id)?;
                        if !finish.ready {
                            return Ok(DrainAgentTurnQueueResult::default());
                        }
                        completed_idle_delivery = true;
                        if state.agent_is_paused(agent_id)?
                            || state
                                .agent(agent_id)?
                                .is_none_or(|agent| agent.pane_id.is_none())
                        {
                            return Ok(DrainAgentTurnQueueResult {
                                source_running: false,
                                completed_idle_delivery,
                            });
                        }
                    }
                    DispatchOutcome::StayedIdle { .. } => {
                        // The turn went to a new pane, not into this agent — it is
                        // still idle, so keep draining (a pause-after delivery turn
                        // pauses it instead; see send_claimed_turn).
                        completed_idle_delivery = true;
                        if state.agent_is_paused(agent_id)?
                            || state
                                .agent(agent_id)?
                                .is_none_or(|agent| agent.pane_id.is_none())
                        {
                            return Ok(DrainAgentTurnQueueResult {
                                source_running: false,
                                completed_idle_delivery,
                            });
                        }
                    }
                }
            }
            AgentTurnClaim::Draining => return Ok(DrainAgentTurnQueueResult::default()),
            AgentTurnClaim::Idle => {
                return Ok(DrainAgentTurnQueueResult {
                    source_running: false,
                    completed_idle_delivery,
                });
            }
        }
    }
}

/// How a claimed turn was dispatched — the single source of truth for whether the
/// owning agent is now busy, derived from the turn's delivery directive in exactly
/// one place (`send_claimed_turn`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DispatchOutcome {
    /// The turn was pasted into the agent's own pane; the agent is running it.
    Ran,
    /// A fork was spawned, but its child has not yet adopted an independent
    /// session and accepted its launch prompt. The source queue is barriered.
    ForkPending,
    /// The turn was delivered to a new pane (fork / new session); the agent
    /// stays idle.
    StayedIdle {
        /// A direct send was queued while this delivery owned the drain guard.
        /// Automatic drains already loop; explicit send-next uses this to honor the
        /// separate fresh send without losing its wakeup.
        resume_queue: bool,
    },
}

/// Sends a turn already claimed via [`AppState::claim_ready_agent_turn`] /
/// [`AppState::claim_next_turn_or_settle`]. Ordinary success and every failure clear
/// the draining guard here. A pending fork deliberately returns with the guard held;
/// its caller must settle any stale source status and call
/// [`AppState::finish_agent_fork_dispatch`] before continuing. That ownership handoff
/// prevents a child-ready/exit hook from racing the caller's status write. A turn
/// carrying another `delivery` directive goes to a new pane instead of this agent's
/// PTY and leaves its status untouched — the caller is expected to keep draining.
fn send_claimed_turn(
    state: &AppState,
    agent_id: &str,
    turn: QueuedTurn,
    pending_turns: usize,
    resume_queue_after_fork: bool,
) -> Result<DispatchOutcome, String> {
    let agent = match state.agent(agent_id)? {
        Some(agent) => agent,
        None => {
            state.requeue_inflight_after_failed_drain(agent_id, turn);
            state.finish_agent_drain(agent_id);
            return Err(format!("Agent {agent_id} was not found"));
        }
    };
    let queued_command = turn
        .delivery
        .is_none()
        .then(|| parse_queued_composer_command(&turn.text))
        .flatten();
    let delivers_to_new_pane = turn.delivery.is_some() || queued_command.is_some();
    let send_result = match (turn.delivery.as_ref(), queued_command) {
        (Some(delivery), _) => {
            // Delivery turns dispatch at-most-once across a crash: drop the durable
            // in-flight copy before spawning, so a crash mid-spawn loses the turn
            // instead of re-running it on restart and minting a duplicate
            // pane/agent/worktree. (Plain turns keep at-least-once semantics —
            // re-pasting text is benign; re-forking is not.)
            state.clear_agent_inflight(agent_id);
            deliver_queued_turn_to_new_pane(
                state,
                &agent,
                &turn.text,
                delivery,
                resume_queue_after_fork,
            )
            .map_err(|message| TurnSendError {
                message,
                text_delivered: false,
            })
        }
        (None, Some(command)) => {
            // Slash-command delivery has the same at-most-once crash semantics as
            // an explicit delivery directive: spawning a duplicate fork is worse
            // than losing the command in the tiny post-spawn/pre-confirm window.
            state.clear_agent_inflight(agent_id);
            deliver_queued_composer_command(state, &agent, command, resume_queue_after_fork)
                .map_err(|message| TurnSendError {
                    message,
                    text_delivered: false,
                })
        }
        (None, None) => send_agent_turn(state, &agent, &turn, AgentSendSource::QueuedTurn)
            .map(|_| DispatchOutcome::Ran),
    };
    let outcome = match send_result {
        Ok(outcome) => outcome,
        Err(err) => {
            // When the turn's text already reached the pane (the paste succeeded and
            // only the submit leg failed), tag the requeued turn so its retry
            // submits a bare Return instead of pasting a second copy that would
            // concatenate onto the one sitting in the composer.
            let mut turn = turn;
            turn.possibly_pasted = turn.possibly_pasted || err.text_delivered;
            state.requeue_inflight_after_failed_drain(agent_id, turn);
            state.finish_agent_drain(agent_id);
            return Err(err.message);
        }
    };
    // Delivered: clear the in-flight record so it isn't re-queued on the next restart
    // (a no-op for delivery turns, which cleared it before dispatch).
    state.clear_agent_inflight(agent_id);
    if turn.pause_after {
        if delivers_to_new_pane {
            // A delivery turn never runs on this agent, so its "pause after" takes
            // effect now rather than arming a pending pause for the next idle.
            state.set_agent_paused(agent_id, true)?;
        } else {
            // A pause-after turn arms the pause; it takes effect when this turn
            // finishes (see `advance_after_idle`), not now.
            state.mark_agent_pending_pause(agent_id)?;
        }
    }
    let outcome = match outcome {
        DispatchOutcome::ForkPending => DispatchOutcome::ForkPending,
        DispatchOutcome::StayedIdle { .. } => DispatchOutcome::StayedIdle {
            resume_queue: state.finish_agent_drain(agent_id),
        },
        DispatchOutcome::Ran => {
            state.finish_agent_drain(agent_id);
            DispatchOutcome::Ran
        }
    };
    let queued_turns = state.agent_queued_turns(agent_id)?;
    state.emit(SessionEvent::new(
        "agent.queued_turn_sent",
        agent.pane_id.clone(),
        Some(agent.id),
        json!({ "pendingTurns": pending_turns, "queuedTurns": queued_turns }),
    ));
    Ok(outcome)
}

/// What an agent going idle should do next.
#[derive(Debug)]
pub enum IdleResolution {
    /// A queued turn was sent; the agent is running again.
    Drained,
    /// The queue is paused (pause-after, or a failed/interrupted/disconnected
    /// turn); nothing was sent.
    Paused,
    /// Nothing to send (empty queue or already paused); the agent is idle.
    Idle,
}

/// Decides what happens when an agent goes idle: enter paused mode if the turn that
/// just finished requested it, stay idle while paused, otherwise drain the next
/// queued turn. Writes status/paused with field-scoped setters so a concurrent hook
/// update can't clobber them. Shared by the Claude and Codex idle handlers.
pub fn advance_after_idle(state: &AppState, agent_id: &str) -> Result<IdleResolution, String> {
    advance_after_settlement(state, agent_id, AgentStatus::Done, true)
}

/// Handles an interrupted turn without presenting it as completed work. Queued
/// follow-ups stay put — they were written assuming this turn would finish — and
/// dependents that asked to wait for actual completion stay blocked. The agent
/// waits for input.
pub fn advance_after_interruption(
    state: &AppState,
    agent_id: &str,
) -> Result<IdleResolution, String> {
    hold_queue_and_settle(state, agent_id, AgentStatus::AwaitingInput, false)
}

/// Pauses a non-empty queue (or consumes a pending pause-after) and settles status
/// without draining. Shared by failure and interruption so a later idle hook cannot
/// treat the bad ending as a successful turn boundary.
fn hold_queue_and_settle(
    state: &AppState,
    agent_id: &str,
    settled_status: AgentStatus,
    release_waiters: bool,
) -> Result<IdleResolution, String> {
    // This is not a successful completion, so a stale queued-send record must not
    // look like "already drained" to a later idle, and must not block Unpause.
    let _ = state.clear_agent_outstanding_sends(agent_id);
    let pending_pause = state.take_agent_pending_pause(agent_id)?;
    let has_queue = !state.agent_queued_turns(agent_id)?.is_empty();
    if pending_pause || has_queue {
        state.set_agent_paused(agent_id, true)?;
    }
    state.set_agent_status(agent_id, settled_status)?;
    if release_waiters {
        release_waiters_for_agent(state, agent_id)?;
    }
    if pending_pause || has_queue {
        Ok(IdleResolution::Paused)
    } else {
        Ok(IdleResolution::Idle)
    }
}

fn advance_after_settlement(
    state: &AppState,
    agent_id: &str,
    settled_status: AgentStatus,
    release_waiters: bool,
) -> Result<IdleResolution, String> {
    // A different completion signal (for example a transcript abort marker racing a
    // Stop hook) may already have drained a queued turn. Until that send receives its
    // prompt-submit echo, another idle signal belongs to the previous turn and must
    // not consume the next queue entry. Report `Drained` because the agent is already
    // running the newly sent turn. Expired advisory records are pruned by the query,
    // so a missing echo cannot block the queue indefinitely.
    //
    // TUI command turns (`!` shell escapes and `/` slash commands) run hooklessly: they
    // never receive a prompt-submit echo, so the record can only be stale by the next
    // idle boundary. Reap those so the real double-drain guard still protects plain
    // queued turns that are in flight.
    let _ = state.clear_agent_outstanding_sends_by(agent_id, |send| {
        send.source == AgentSendSource::QueuedTurn && is_tui_command_turn(&send.text)
    });
    if state.agent_has_outstanding_send_source(agent_id, AgentSendSource::QueuedTurn)? {
        return Ok(IdleResolution::Drained);
    }
    // Outstanding-send tracking is advisory; clear it best-effort on every idle.
    let _ = state.clear_agent_outstanding_sends(agent_id);

    // Looped so a delivery turn — which goes to a new pane and leaves this agent
    // idle — falls through to the next queued turn (or settles the agent to Done)
    // in the same idle event, instead of stranding the rest of the queue in a
    // status that never fires another idle hook. Each iteration re-checks the
    // pause state, so a pause-after delivery turn still halts the queue.
    loop {
        // The pause branches settle with the caller's status and waiter policy
        // too: an *interrupted* turn received while an agent is pausing was still
        // aborted, so presenting it as Done — and releasing dependents that
        // asked to wait for actual completion — would defeat the interruption
        // settlement path.
        if state.take_agent_pending_pause(agent_id)? {
            state.set_agent_paused(agent_id, true)?;
            state.set_agent_status(agent_id, settled_status)?;
            if release_waiters {
                release_waiters_for_agent(state, agent_id)?;
            }
            return Ok(IdleResolution::Paused);
        }
        if state.agent_is_paused(agent_id)? {
            // Paused: leave the queue intact and don't auto-send.
            state.set_agent_status(agent_id, settled_status)?;
            if release_waiters {
                release_waiters_for_agent(state, agent_id)?;
            }
            return Ok(IdleResolution::Idle);
        }
        // Atomically claim a ready turn, observe that another drain owns the agent, or
        // settle to the requested ready status — all under one model lock. This both
        // serializes draining (so a racing trigger can't double-send) and folds the typing
        // check into the same lock as the status write, closing the typing/idle lost-wakeup.
        // The user-is-typing case is handled inside as an idle settle (the queue is held;
        // it resumes when the frontend clears the typing flag).
        match state.claim_next_turn_or_settle(agent_id, settled_status)? {
            IdleAdvance::Sent { turn, pending } => {
                let is_delivery = turn.delivery.is_some();
                match send_claimed_turn(state, agent_id, turn, pending, true) {
                    Ok(DispatchOutcome::Ran) => return Ok(IdleResolution::Drained),
                    Ok(DispatchOutcome::ForkPending) => {
                        // Settle while the fork dispatch still owns the ordinary drain
                        // guard. A racing ready/exit signal can only mark the barrier;
                        // finish then atomically hands ownership either back to this
                        // loop or to the later hook-side resume path.
                        state.set_agent_status(agent_id, settled_status)?;
                        let finish = state.finish_agent_fork_dispatch(agent_id)?;
                        if finish.ready
                            && state
                                .agent(agent_id)?
                                .is_some_and(|agent| agent.pane_id.is_some())
                        {
                            continue;
                        }
                        if release_waiters {
                            release_waiters_for_agent(state, agent_id)?;
                        }
                        return Ok(IdleResolution::Idle);
                    }
                    Ok(DispatchOutcome::StayedIdle { .. }) => {
                        // A source can detach while its fork/new-session child is being
                        // spawned. Do not loop into a parked queue that no longer owns a
                        // pane; the detach path leaves it recoverable and releases any
                        // now-resolved dependents.
                        if state
                            .agent(agent_id)?
                            .is_none_or(|agent| agent.pane_id.is_none())
                        {
                            return Ok(IdleResolution::Idle);
                        }
                        continue;
                    }
                    Err(err) => {
                        if is_delivery {
                            // A failed delivery leaves this agent idle;
                            // settle it and release its waiters so the error
                            // (surfaced as a queue error by the caller) doesn't
                            // strand the tab in a stale Running status that no
                            // future idle hook will ever clear.
                            state.set_agent_status(agent_id, settled_status)?;
                            if release_waiters {
                                release_waiters_for_agent(state, agent_id)?;
                            }
                        }
                        return Err(err);
                    }
                }
            }
            IdleAdvance::Busy => {
                // Another drain is mid-send and owns the status transition; leave it be.
                return Ok(IdleResolution::Idle);
            }
            IdleAdvance::Idle => {
                if release_waiters {
                    release_waiters_for_agent(state, agent_id)?;
                }
                return Ok(IdleResolution::Idle);
            }
        }
    }
}

pub fn release_waiters_for_agent(state: &AppState, target_agent_id: &str) -> Result<usize, String> {
    let mut resolved_targets = VecDeque::from([target_agent_id.to_string()]);
    let mut scheduled_targets = HashSet::from([target_agent_id.to_string()]);
    let mut drained_count = 0;

    while let Some(resolved_target_id) = resolved_targets.pop_front() {
        let waiting_agent_ids = state.agents_with_front_wait_for(&resolved_target_id)?;
        for source_agent_id in waiting_agent_ids {
            if source_agent_id == resolved_target_id {
                continue;
            }
            let Some(source) = state.agent(&source_agent_id)? else {
                continue;
            };
            if source.paused || state.agent_is_typing(&source.id)? {
                continue;
            }
            let policy = agent_composer_policy(state, &source)?;
            if !policy.can_send(source.status) {
                continue;
            }
            match drain_agent_turn_queue_inner(state, &source.id) {
                Ok(result) => {
                    if result.source_running {
                        drained_count += 1;
                    }
                    if result.completed_idle_delivery && scheduled_targets.insert(source.id.clone())
                    {
                        resolved_targets.push_back(source.id.clone());
                    }
                    if result.source_running
                        && let Some(updated) = state.agent(&source.id)?
                    {
                        state.emit(SessionEvent::new(
                            "agent.running",
                            updated.pane_id.clone(),
                            Some(updated.id.clone()),
                            json!({ "agent": updated }),
                        ));
                    }
                }
                Err(err) => {
                    state.emit(SessionEvent::new(
                        "agent.queue_error",
                        source.pane_id.clone(),
                        Some(source.id.clone()),
                        json!({ "error": err }),
                    ));
                }
            }
        }
    }

    Ok(drained_count)
}

/// Releases a barrier only after the child process has definitively exited. This is
/// the failure escape hatch: there is no live process left that can continue copying
/// the source transcript, so later source turns are safe to resume without a timer.
pub fn abort_fork_barrier_for_child(
    state: &AppState,
    child_agent_id: &str,
    reason: &str,
) -> Result<bool, String> {
    let Some(released) = state.abort_agent_fork_barrier(child_agent_id)? else {
        return Ok(false);
    };
    resume_source_after_fork_barrier(
        state,
        &released.source_agent_id,
        child_agent_id,
        Some(reason),
        released.resume_queue,
    )?;
    Ok(true)
}

fn resume_source_after_fork_barrier(
    state: &AppState,
    source_agent_id: &str,
    child_agent_id: &str,
    failure: Option<&str>,
    resume_queue: bool,
) -> Result<(), String> {
    let queued_turns = state.agent_queued_turns(source_agent_id)?;
    let Some(source) = state.agent(source_agent_id)? else {
        // The source was closed while the child initialized. A waiter targeting the
        // vanished source is now resolved, and this child lifecycle signal is the
        // final deterministic wakeup available to it.
        release_waiters_for_agent(state, source_agent_id)?;
        return Ok(());
    };
    let event_type = if failure.is_some() {
        "agent.queue_error"
    } else {
        "agent.fork_ready"
    };
    state.emit(SessionEvent::new(
        event_type,
        source.pane_id.clone(),
        Some(source.id.clone()),
        json!({
            "childAgentId": child_agent_id,
            "error": failure,
            "pendingTurns": queued_turns.len(),
            "queuedTurns": queued_turns,
        }),
    ));

    let should_resume = resume_queue
        && source.pane_id.is_some()
        && !source.paused
        && !state.agent_is_typing(source_agent_id)?
        && agent_composer_policy(state, &source)?.can_send(source.status);
    if should_resume {
        match drain_agent_turn_queue(state, source_agent_id) {
            Ok(true) => {
                if let Some(updated) = state.agent(source_agent_id)? {
                    state.emit(SessionEvent::new(
                        "agent.running",
                        updated.pane_id.clone(),
                        Some(updated.id.clone()),
                        json!({ "agent": updated }),
                    ));
                }
            }
            Ok(false) => {}
            Err(err) => {
                let queued_turns = state.agent_queued_turns(source_agent_id)?;
                state.emit(SessionEvent::new(
                    "agent.queue_error",
                    source.pane_id.clone(),
                    Some(source.id.clone()),
                    json!({ "error": err, "queuedTurns": queued_turns }),
                ));
                // Still notify dependents below. The failed drain normally requeues
                // its turn, so the wait predicate keeps them blocked rather than
                // silently treating the source as complete.
            }
        }
    }

    // Barrier completion is itself a target-state transition. This must run even
    // when manual send-next disabled source queue resumption, or when pause/typing
    // intentionally held it: an empty source queue is complete, while a non-empty
    // one remains blocked by the ordinary wait predicate.
    release_waiters_for_agent(state, source_agent_id)?;
    Ok(())
}

/// Delivers a queued turn that targets a new pane instead of the source agent's own
/// PTY: fork the source session (optionally into a fresh worktree) or start a fresh
/// sibling session, launched with the turn text as its first message. The source
/// agent's status is deliberately left untouched — it stays idle and the caller
/// continues draining its queue.
fn deliver_queued_turn_to_new_pane(
    state: &AppState,
    source: &AgentInfo,
    text: &str,
    delivery: &QueuedTurnDelivery,
    resume_queue_after_fork: bool,
) -> Result<DispatchOutcome, String> {
    match delivery {
        QueuedTurnDelivery::Fork { use_worktree } => {
            let pane = fork_agent_source(state, source, *use_worktree, Some(text))?;
            begin_queued_fork_barrier(state, source, &pane, resume_queue_after_fork)
        }
        QueuedTurnDelivery::NewSession => {
            spawn_sibling_agent_session(state, source, text)?;
            Ok(DispatchOutcome::StayedIdle {
                resume_queue: false,
            })
        }
    }
}

/// Dispatches a Session slash command parsed from the front of a plain queued turn.
/// The stored text keeps the command visible in the queue; only the launch prompt
/// has its command prefix removed.
fn deliver_queued_composer_command(
    state: &AppState,
    source: &AgentInfo,
    command: QueuedComposerCommand<'_>,
    resume_queue_after_fork: bool,
) -> Result<DispatchOutcome, String> {
    match command {
        QueuedComposerCommand::Fork {
            prompt,
            use_worktree,
        } => {
            let pane = fork_agent_source(state, source, use_worktree, Some(prompt))?;
            begin_queued_fork_barrier(state, source, &pane, resume_queue_after_fork)
        }
    }
}

fn begin_queued_fork_barrier(
    state: &AppState,
    source: &AgentInfo,
    pane: &crate::state::PaneInfo,
    resume_queue_after_fork: bool,
) -> Result<DispatchOutcome, String> {
    let child_agent_id = pane
        .agent_id
        .as_deref()
        .ok_or_else(|| format!("forked pane {} has no agent", pane.id))?;
    if state.begin_agent_fork_barrier(&source.id, child_agent_id, resume_queue_after_fork)? {
        Ok(DispatchOutcome::ForkPending)
    } else {
        Ok(DispatchOutcome::StayedIdle {
            resume_queue: false,
        })
    }
}

/// A failed turn send. `text_delivered` reports whether the turn's text had
/// already reached the pane when the failure occurred (the paste succeeded; only the
/// submit leg failed), so the requeue can tag the turn `possibly_pasted` and its
/// retry can avoid pasting a duplicate copy.
struct TurnSendError {
    message: String,
    text_delivered: bool,
}

/// Encode a Session-authored Grok turn as ordinary terminal input rather than a
/// bracketed paste. Grok treats every bracketed-paste event as an instruction to
/// inspect the host clipboard for attachments; a sidebar send could therefore
/// append an unrelated clipboard image to the text Session supplied. Alt+Enter is
/// Grok's documented, terminal-portable newline chord, so it preserves multiline
/// drafts without generating a paste event.
///
/// Tabs cannot be delivered as ordinary bytes because Grok interprets Tab as an
/// autocomplete key. Expand them to the conventional four spaces. Other C0
/// controls are omitted: unlike bracketed paste, this path is terminal input and
/// must never let prompt text forge control sequences.
fn grok_typed_turn_data(text: &str) -> String {
    let mut data = String::with_capacity(text.len());
    let mut previous_was_cr = false;
    for character in text.chars() {
        match character {
            '\r' => {
                data.push_str("\x1b\r");
                previous_was_cr = true;
            }
            '\n' if previous_was_cr => {
                previous_was_cr = false;
            }
            '\n' => {
                data.push_str("\x1b\r");
                previous_was_cr = false;
            }
            '\t' => {
                data.push_str("    ");
                previous_was_cr = false;
            }
            character if character.is_control() => {
                previous_was_cr = false;
            }
            character => {
                data.push(character);
                previous_was_cr = false;
            }
        }
    }
    data
}

/// The pane write for one turn: a `possibly_pasted` turn's text is (very likely)
/// already sitting in the composer from a failed prior attempt, so it submits a
/// bare Return instead of pasting a second copy — the concatenation that tag
/// exists to prevent. The outstanding-send record still contains the full text, so
/// the prompt-submit echo of the already-pasted content confirms it normally.
fn turn_write_options(agent: &AgentInfo, pane_id: String, turn: &QueuedTurn) -> PaneWriteOptions {
    if turn.possibly_pasted {
        PaneWriteOptions {
            pane_id,
            data: String::new(),
            paste: false,
            submit: true,
        }
    } else if agent.adapter == "grok" {
        PaneWriteOptions {
            pane_id,
            data: grok_typed_turn_data(&turn.text),
            paste: false,
            submit: true,
        }
    } else {
        PaneWriteOptions {
            pane_id,
            data: turn.text.clone(),
            paste: true,
            submit: true,
        }
    }
}

/// Writes one turn into the agent's own pane: reserve prompt-correlation, paste
/// and submit, promote the status, then arm the submit-confirmation watch. Does
/// not requeue on failure — the caller owns the turn and decides (a queue drain
/// rolls it back to the front, tagged via `TurnSendError::text_delivered`).
fn send_agent_turn(
    state: &AppState,
    agent: &AgentInfo,
    turn: &QueuedTurn,
    source: AgentSendSource,
) -> Result<(), TurnSendError> {
    let pane_id = agent.pane_id.clone().ok_or_else(|| TurnSendError {
        message: format!("agent {} does not have an attached pane", agent.id),
        text_delivered: false,
    })?;
    let is_command = is_tui_command_turn(&turn.text);
    // Reserve prompt-correlation before Return reaches the PTY. The acknowledged
    // native path does not return until Return has been flushed, so Claude can emit
    // UserPromptSubmit on another thread before this function resumes. Recording
    // afterward would miss that echo and leave a false outstanding send for the
    // watchdog. Roll the exact record back if delivery fails.
    let send_id = match state.record_agent_send(&agent.id, turn.text.clone(), source) {
        Ok(send_id) => Some(send_id),
        Err(err) => {
            eprintln!(
                "session: failed to record send for agent {}: {err}",
                agent.id
            );
            None
        }
    };
    if let Err(failure) = write_pane_detailed(state, turn_write_options(agent, pane_id, turn)) {
        if let Some(send_id) = send_id {
            let _ = state.remove_agent_outstanding_send_id(&agent.id, send_id);
        }
        // A possibly-pasted turn's text was delivered by the *previous* attempt,
        // whatever this write's payload leg (a bare Return) reports.
        return Err(TurnSendError {
            message: failure.error,
            text_delivered: failure.data_delivered || turn.possibly_pasted,
        });
    }
    // Everything from here on happened after the turn's bytes reached the pane, so
    // any failure reports the text as delivered.
    let delivered_err = |message: String| TurnSendError {
        message,
        text_delivered: true,
    };
    // Field-scoped status write: a full-struct update_agent here would drop the lock
    // between read and write and could clobber a concurrent SessionStart hook's
    // session_id/transcript_path (leaving the session unresumable/unforkable). Only
    // the status changes, so write only the status.
    if is_command {
        // A built-in TUI command (a `/` slash command or a `!` shell escape) can run
        // hooklessly — no UserPromptSubmit, no Stop/idle — so it never represents a
        // running turn. Marking it Running would stick forever (nothing demotes it).
        // A direct send only reaches here from a can-send (already-ready) status, so
        // there is nothing to clear; but when the same command is *drained from the
        // queue*, the agent is still Running from the just-finished turn, and the
        // drain path (claim_next_turn_or_settle's Sent branch) leaves that Running
        // in place — wedging the pane at "Working…" and freezing the queue behind it.
        // Demote that stale working status so the queue can't deadlock. Skills that do
        // start a real turn re-promote via their own UserPromptSubmit/PreToolUse hooks.
        if let Some(current) = state.agent(&agent.id).map_err(delivered_err)?
            && matches!(current.status, AgentStatus::Running | AgentStatus::Starting)
        {
            state
                .set_agent_status(&agent.id, AgentStatus::AwaitingInput)
                .map_err(delivered_err)?;
        }
    } else {
        state
            .set_agent_status(&agent.id, AgentStatus::Running)
            .map_err(delivered_err)?;
    }
    // A plain-text turn is pasted then submitted with a trailing Return. The paste is
    // durable (it appears in the composer) but the lone Return can be dropped, leaving
    // the turn typed-but-unsubmitted. Arm a watchdog to detect and nudge that. Skip
    // TUI commands: they can run hooklessly, so they never echo the UserPromptSubmit
    // the watchdog keys on, and a spurious Return after one could misfire.
    if !is_command && let Some(send_id) = send_id {
        watch_agent_after_queued_send(state, agent, source, send_id, turn);
    }
    Ok(())
}

/// Grace before the first check of whether a just-sent turn actually submitted. A
/// real submit echoes a `UserPromptSubmit` hook (which pops the outstanding send)
/// and writes the prompt to the transcript within a few hundred ms, so a window
/// this size reliably separates "submitted and running" from "the Return was
/// dropped and the text is sitting unsubmitted".
const SUBMIT_CONFIRM_GRACE: std::time::Duration = std::time::Duration::from_millis(1200);

/// Additional waits before the second and final checks (cumulative ~3s and ~8s
/// after the send). Each non-final check that finds the send still unmatched — and
/// no prompt of any kind submitted since — nudges another bare Return; the final
/// check reclaims the turn instead (see [`reclaim_unconfirmed_send`]).
const SUBMIT_CONFIRM_RECHECKS: [std::time::Duration; 2] = [
    std::time::Duration::from_millis(1800),
    std::time::Duration::from_millis(5000),
];

/// What one submit-watch check should do, derived from [`SubmitWatchStatus`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SubmitWatchDecision {
    /// Confirmed — or ambiguous (a prompt was submitted after our send but failed
    /// the containment match, so the turn very likely started). Both stop recovery:
    /// nudging or requeueing a turn that actually started risks a duplicate, and a
    /// visible stall is the safer failure.
    StandDown,
    /// Still pending with checks remaining: re-send a bare Return (no paste — the
    /// text is already in the composer) and keep watching.
    NudgeReturn,
    /// Still pending on the final check: the turn never started despite the nudges;
    /// return it to the queue.
    Reclaim,
}

fn decide_submit_watch(status: SubmitWatchStatus, final_check: bool) -> SubmitWatchDecision {
    match status {
        SubmitWatchStatus::Confirmed | SubmitWatchStatus::StillPendingWithPromptActivity => {
            SubmitWatchDecision::StandDown
        }
        SubmitWatchStatus::StillPending if final_check => SubmitWatchDecision::Reclaim,
        SubmitWatchStatus::StillPending => SubmitWatchDecision::NudgeReturn,
    }
}

/// After a queued/direct turn is pasted-and-submitted into an agent's own pane,
/// verify the submit succeeded and recover if it did not. The failure this recovers:
/// the bracketed paste reaches the TUI (visible in the composer) but the trailing
/// Return is dropped — because it arrives before the composer is re-armed to
/// submit, or, in the native terminal, races the still-in-flight paste, leaving the
/// turn blocked with the tab stuck at a false "Working…". Recovery escalates: a
/// bare Return is re-sent at each non-final check, and a turn still showing no sign
/// of having started by the final check is returned to the queue (tagged
/// possibly-pasted so its retry cannot duplicate the text). Only turns that go into
/// the agent's own pane and echo their prompt promptly are watched: `Steer` targets
/// a busy agent whose echo legitimately waits for the current turn boundary, so it
/// is excluded to avoid a spurious mid-turn Return.
fn watch_agent_after_queued_send(
    state: &AppState,
    agent: &AgentInfo,
    source: AgentSendSource,
    send_id: u64,
    turn: &QueuedTurn,
) {
    if !matches!(
        source,
        AgentSendSource::QueuedTurn | AgentSendSource::DirectSend
    ) {
        return;
    }
    let Some(pane_id) = agent.pane_id.clone() else {
        return;
    };
    // One watcher per exact send: overlapping sends (a direct send shortly after a
    // queued drain) each get their own confirmation instead of the second going
    // unwatched, while a double arm of the same send stays deduped.
    if !state.begin_agent_submit_watch(&agent.id, send_id) {
        return;
    }
    let state = state.clone();
    let agent_id = agent.id.clone();
    let turn = turn.clone();
    std::thread::spawn(move || {
        run_agent_submit_watch(&state, &agent_id, &pane_id, send_id, turn);
        state.end_agent_submit_watch(&agent_id, send_id);
    });
}

/// The watcher-thread body of [`watch_agent_after_queued_send`]: sleep, check,
/// act, repeat through the escalation schedule.
fn run_agent_submit_watch(
    state: &AppState,
    agent_id: &str,
    pane_id: &str,
    send_id: u64,
    turn: QueuedTurn,
) {
    let checks = 1 + SUBMIT_CONFIRM_RECHECKS.len();
    let delays = std::iter::once(SUBMIT_CONFIRM_GRACE).chain(SUBMIT_CONFIRM_RECHECKS);
    for (index, delay) in delays.enumerate() {
        std::thread::sleep(delay);
        let Ok(status) = state.check_agent_submit_watch(agent_id, send_id) else {
            return;
        };
        match decide_submit_watch(status, index + 1 == checks) {
            SubmitWatchDecision::StandDown => {
                if status == SubmitWatchStatus::StillPendingWithPromptActivity {
                    eprintln!(
                        "session: a turn sent to agent {agent_id} never matched its prompt echo, \
                         but a prompt was submitted after it; standing down to avoid a duplicate"
                    );
                }
                return;
            }
            SubmitWatchDecision::NudgeReturn => {
                // Best-effort: a failure here leaves the turn where it was, no
                // worse off; the next check escalates.
                let _ = write_pane(
                    state,
                    PaneWriteOptions {
                        pane_id: pane_id.to_string(),
                        data: String::new(),
                        paste: false,
                        submit: true,
                    },
                );
                eprintln!(
                    "session: re-sent Return for agent {agent_id}; a sent turn appeared unsubmitted"
                );
            }
            SubmitWatchDecision::Reclaim => {
                reclaim_unconfirmed_send(state, agent_id, pane_id, send_id, turn);
                return;
            }
        }
    }
}

/// The final escalation of a submit watch: the exact send is still unmatched and no
/// prompt at all was submitted since it was written, so after the unanswered Return
/// nudges the turn is treated as never-started and returned to the front of its
/// queue — tagged possibly-pasted, so the eventual retry submits a bare Return
/// rather than pasting a duplicate copy onto the text already in the composer. The
/// agent's optimistic Running from the failed send is demoted so the tab doesn't
/// sit at a false "Working…" and future drain triggers aren't gated off. Removing
/// the outstanding-send record and requeueing are atomic; if the prompt echo arrives
/// in the race window the whole reclaim is a no-op.
fn reclaim_unconfirmed_send(
    state: &AppState,
    agent_id: &str,
    pane_id: &str,
    send_id: u64,
    mut turn: QueuedTurn,
) {
    turn.possibly_pasted = true;
    let queued_turns = match state.requeue_unconfirmed_send(agent_id, send_id, turn) {
        Ok(Some(queued_turns)) => queued_turns,
        Ok(None) => return,
        Err(err) => {
            eprintln!("session: failed to reclaim an unconfirmed turn for agent {agent_id}: {err}");
            return;
        }
    };
    eprintln!("session: a turn sent to agent {agent_id} never started; returned it to the queue");
    if let Ok(Some(agent)) = state.agent(agent_id)
        && matches!(agent.status, AgentStatus::Running | AgentStatus::Starting)
    {
        let _ = state.set_agent_status(agent_id, AgentStatus::AwaitingInput);
    }
    state.emit(SessionEvent::new(
        "agent.turn_queued",
        Some(pane_id.to_string()),
        Some(agent_id.to_string()),
        json!({ "pendingTurns": queued_turns.len(), "queuedTurns": queued_turns.clone() }),
    ));
    state.emit(SessionEvent::new(
        "agent.queue_error",
        Some(pane_id.to_string()),
        Some(agent_id.to_string()),
        json!({
            "error": "A sent turn never started; it was returned to the queue",
            "queuedTurns": queued_turns,
        }),
    ));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{
        AdapterConfigs, ClaudeAdapterConfig, CodexAdapterConfig, GrokAdapterConfig, SessionConfig,
    };
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn queued_composer_commands_match_only_exact_front_tokens() {
        assert_eq!(
            parse_queued_composer_command("/fork fix the tests"),
            Some(QueuedComposerCommand::Fork {
                prompt: "fix the tests",
                use_worktree: false,
            })
        );
        assert_eq!(
            parse_queued_composer_command("/worktree\tfix the tests"),
            Some(QueuedComposerCommand::Fork {
                prompt: "fix the tests",
                use_worktree: true,
            })
        );
        assert_eq!(
            parse_queued_composer_command("/btw   investigate this\n"),
            None
        );
        assert_eq!(parse_queued_composer_command(" /fork not at front"), None);
        assert_eq!(parse_queued_composer_command("/forked not exact"), None);
        assert_eq!(parse_queued_composer_command("/fork"), None);
        assert_eq!(parse_queued_composer_command("prefix /btw no"), None);
    }

    fn temp_workspace() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("session-turn-queue-{nanos}-{seq}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn test_state() -> AppState {
        AppState::new(SessionConfig {
            remotes: Default::default(),
            workspace_root: temp_workspace(),
            socket_path: PathBuf::from("/tmp/session-test.sock"),
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
            claude_plugin_dir: std::path::PathBuf::new(),
        })
    }

    fn sample_agent(status: AgentStatus) -> AgentInfo {
        AgentInfo {
            id: "agent-1".to_string(),
            group_id: "group-1".to_string(),
            adapter: "claude".to_string(),
            worktree_dir: "/tmp/work/agent-1".to_string(),
            branch: None,
            active_workspace: None,
            pane_id: Some("missing-pane".to_string()),
            orphaned_queue_pane_id: None,
            session_id: None,
            transcript_path: None,
            status,
            model: None,
            effort: None,
            approval_mode: None,
            parent_id: None,
            fork_point: None,
            root_session_id: None,
            thread_id: None,
            branch_id: None,
            native_leaf_id: None,
            paused: false,
            created_at: 1,
        }
    }

    fn sample_agent_with_id(id: &str, status: AgentStatus, pane_id: Option<&str>) -> AgentInfo {
        AgentInfo {
            id: id.to_string(),
            group_id: "group-1".to_string(),
            adapter: "claude".to_string(),
            worktree_dir: format!("/tmp/work/{id}"),
            branch: None,
            active_workspace: None,
            pane_id: pane_id.map(ToString::to_string),
            orphaned_queue_pane_id: None,
            session_id: None,
            transcript_path: None,
            status,
            model: None,
            effort: None,
            approval_mode: None,
            parent_id: None,
            fork_point: None,
            root_session_id: None,
            thread_id: None,
            branch_id: None,
            native_leaf_id: None,
            paused: false,
            created_at: 1,
        }
    }

    #[test]
    fn tui_command_turns_cover_shell_escapes_and_slash_commands() {
        assert!(is_tui_command_turn("!git status"));
        assert!(is_tui_command_turn("/model"));
        assert!(is_tui_command_turn("  /compact keep the plan"));
        assert!(!is_tui_command_turn("fix the bug in /src/main.rs"));
        assert!(!is_tui_command_turn(""));
    }

    #[test]
    fn submit_watch_nudges_then_reclaims_a_turn_that_never_submitted() {
        let state = test_state();

        // A queued send that never echoed a UserPromptSubmit — and saw no prompt
        // of any kind after it — looks dropped: non-final checks nudge a Return,
        // the final check reclaims the turn.
        let send_id = state
            .record_agent_send("agent-1", "commit".to_string(), AgentSendSource::QueuedTurn)
            .unwrap();
        let status = state.check_agent_submit_watch("agent-1", send_id).unwrap();
        assert_eq!(status, SubmitWatchStatus::StillPending);
        assert_eq!(
            decide_submit_watch(status, false),
            SubmitWatchDecision::NudgeReturn
        );
        assert_eq!(
            decide_submit_watch(status, true),
            SubmitWatchDecision::Reclaim
        );
    }

    #[test]
    fn submit_watch_ignores_unrelated_late_activity() {
        let state = test_state();
        state
            .insert_agent(sample_agent_with_id(
                "agent-1",
                AgentStatus::Running,
                Some("pane-1"),
            ))
            .unwrap();

        let send_id = state
            .record_agent_send("agent-1", "commit".to_string(), AgentSendSource::QueuedTurn)
            .unwrap();
        // A late status/transcript mutation from the previous turn is not proof
        // that this exact prompt submitted; its outstanding record still requires
        // recovery.
        state
            .set_agent_status("agent-1", AgentStatus::Running)
            .unwrap();
        assert_eq!(
            state.check_agent_submit_watch("agent-1", send_id).unwrap(),
            SubmitWatchStatus::StillPending
        );
    }

    #[test]
    fn submit_watch_stands_down_when_send_already_echoed() {
        let state = test_state();

        // No outstanding send (the UserPromptSubmit echo already popped it):
        // nothing to nudge even though the agent is otherwise quiet.
        let status = state.check_agent_submit_watch("agent-1", 1).unwrap();
        assert_eq!(status, SubmitWatchStatus::Confirmed);
        assert_eq!(
            decide_submit_watch(status, false),
            SubmitWatchDecision::StandDown
        );
        assert_eq!(
            decide_submit_watch(status, true),
            SubmitWatchDecision::StandDown
        );
    }

    #[test]
    fn submit_watch_reservation_is_per_send() {
        let state = test_state();
        assert!(state.begin_agent_submit_watch("agent-1", 1));
        // Same send: deduped. A different overlapping send: watched independently.
        assert!(!state.begin_agent_submit_watch("agent-1", 1));
        assert!(state.begin_agent_submit_watch("agent-1", 2));
        state.end_agent_submit_watch("agent-1", 1);
        assert!(state.begin_agent_submit_watch("agent-1", 1));
    }

    #[test]
    fn grok_typed_turns_cannot_inject_terminal_controls() {
        assert_eq!(
            grok_typed_turn_data("safe\x1b[201~\r\nnext\u{7}"),
            "safe[201~\x1b\rnext"
        );
    }

    #[test]
    fn interruption_settles_agent_to_awaiting_input() {
        let state = test_state();
        state
            .insert_agent(sample_agent(AgentStatus::Running))
            .unwrap();

        let resolution = advance_after_interruption(&state, "agent-1").unwrap();

        assert!(matches!(resolution, IdleResolution::Idle));
        assert!(matches!(
            state.agent("agent-1").unwrap().unwrap().status,
            AgentStatus::AwaitingInput
        ));
    }

    #[test]
    fn aborted_manual_send_next_barrier_does_not_request_automatic_resume() {
        let state = test_state();
        state
            .insert_agent(sample_agent_with_id("source", AgentStatus::Done, None))
            .unwrap();
        let mut child = sample_agent_with_id("child", AgentStatus::Running, None);
        child.parent_id = Some("source".to_string());
        child.fork_point = Some("source-session".to_string());
        state.insert_agent(child).unwrap();
        assert!(
            state
                .begin_agent_fork_barrier("source", "child", false)
                .unwrap()
        );

        assert_eq!(
            state.abort_agent_fork_barrier("child").unwrap(),
            Some(crate::state::ReleasedAgentForkBarrier {
                source_agent_id: "source".to_string(),
                resume_queue: false,
            })
        );
    }
}
