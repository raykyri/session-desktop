// The follow-up queue: questions asked at the end of an inline chain while
// the chain could not accept one, kept per chain head in the model (and in
// state.json as `researchFollowups`) and sent in order as previous turns complete.
// It follows the web server's queue (web/packages/db/src/repos/followups.ts,
// web/packages/server/src/research/followups.ts) and the shared rules in
// `researchQueueAction` (web/packages/shared/src/lib/researchBranchView.ts):
//
// - Asking sends immediately when nothing is queued for the chain and its last
//   answer can accept a follow-up; otherwise the question is added to the queue. A
//   question queued behind a stopped run is rejected with the composer note.
// - Dispatch sends a chain's first item once the chain's last answer has
//   completed with a recorded checkpoint. It runs when a run settles, after
//   a branch removal, a chain-order change, a restore from the Archive or the
//   Trash, a cancel or retry, and at startup. Threads in the Archive or the
//   Trash do not dispatch.
// - A rejected send records `failed_reason`; subsequent items in the chain remain
//   queued until that item is retried or cancelled.
// - The images of a queued item are referenced by the queue (see
//   `research_image_ids`), so they stay in the image store; a cancel releases
//   them, and a send transfers them to the new node.

use super::*;
use crate::research::{QueuedResearchFollowup, ResearchFollowupQueueItem};
use crate::tweets::ResearchMessageAttachment;
use serde::{Deserialize, Serialize};
use std::sync::MutexGuard;

/// Starts the run of an admitted follow-up (a Queued node). It
/// settles the node as Failed when the launch fails.
pub type FollowupLauncher = Arc<dyn Fn(&AppState, &ResearchNode) + Send + Sync>;

/// Why a send was not made although the queue chose it: the chain or its
/// queue changed in between. The next dispatch reads them again.
pub(super) const RESEARCH_FOLLOWUP_CHANGED_ERROR: &str =
    "The conversation changed before the queued follow-up was sent.";

/// The ask box's notes for a chain whose last answer stopped
/// (`researchChainComposerState` in the shared researchThreadView).
const STALLED_FAILED_MESSAGE: &str =
    "The last answer stopped with an error. Retry it or edit its question to continue.";
const STALLED_STOPPED_MESSAGE: &str = "The last answer was stopped. Run it again to continue.";

/// Recorded on an item migrated from the webview's storage whose images are
/// no longer stored.
const MIGRATED_IMAGES_MISSING: &str =
    "The images in this question are no longer available. Edit the question to attach them again.";

/// What asking a follow-up did.
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ResearchFollowupAsk {
    /// Admitted as the chain's next message, and its run started.
    #[serde(rename_all = "camelCase")]
    Sent {
        #[serde(serialize_with = "serialize_node_view")]
        node: ResearchNode,
        head_node_id: String,
    },
    /// Added to the end of the chain's queue.
    #[serde(rename_all = "camelCase")]
    Queued {
        item: ResearchFollowupQueueItem,
        head_node_id: String,
    },
}

fn serialize_node_view<S: serde::Serializer>(
    node: &ResearchNode,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    node.view().serialize(serializer)
}

/// An image of a queued follow-up stored by earlier builds, as received from
/// the webview.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyQueuedResearchFollowupImage {
    pub id: String,
    #[serde(default)]
    pub file_name: Option<String>,
}

/// A queued follow-up that earlier builds kept in the webview's
/// localStorage, imported into backend persistence.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyQueuedResearchFollowup {
    pub id: String,
    pub head_node_id: String,
    pub prompt: String,
    pub created_at: f64,
    #[serde(default)]
    pub images: Vec<LegacyQueuedResearchFollowupImage>,
    /// Tweets and other references resolved from the prompt by the command.
    #[serde(skip)]
    pub attachments: Vec<ResearchMessageAttachment>,
}

/// Whether the last message of the chain headed by `head_id` can accept a
/// follow-up (`researchQueueStep`): send it (with the tail's id), wait (the
/// answer is running, or its checkpoint is not recorded yet), or stalled
/// (the answer failed or was stopped, with the composer note).
enum ChainTail {
    Send(String),
    Wait,
    Stalled(&'static str),
}

fn chain_tail(nodes: &HashMap<String, ResearchNode>, head_id: &str) -> ChainTail {
    let chain = research_inline_chain(nodes, head_id);
    let Some(tail) = chain.last().and_then(|tail_id| nodes.get(tail_id)) else {
        return ChainTail::Wait;
    };
    let status = tail.status();
    if status.is_active() {
        return ChainTail::Wait;
    }
    match status {
        ResearchNodeStatus::Complete => {}
        ResearchNodeStatus::Failed => return ChainTail::Stalled(STALLED_FAILED_MESSAGE),
        _ => return ChainTail::Stalled(STALLED_STOPPED_MESSAGE),
    }
    // `canFollowUpFrom`: a follow-up of an exchange forks its native
    // session, so it waits for the checkpoint; posts and documents launch
    // fresh runs with their content as context.
    let ready = match tail.follow_up_launch() {
        FollowUpLaunch::Context(_) => true,
        FollowUpLaunch::Fork => tail
            .binding()
            .is_some_and(|binding| binding.native_session_id.is_some()),
    };
    if ready {
        ChainTail::Send(tail.id.clone())
    } else {
        ChainTail::Wait
    }
}

/// The agent a queued follow-up runs on: the one chosen, else the one the
/// chain's last message runs on (follow-ups of an answer inherit it), else
/// the default agent.
fn queued_followup_agent(
    state: &AppState,
    model: &Model,
    head_id: &str,
    chosen: Option<research::AgentSpec>,
) -> Result<research::AgentSpec, String> {
    if let Some(chosen) = chosen {
        return Ok(chosen);
    }
    let tail_agent = research_inline_chain(&model.research_nodes, head_id)
        .last()
        .and_then(|tail_id| model.research_nodes.get(tail_id))
        .and_then(|tail| tail.agent().cloned())
        .filter(|agent| !agent.adapter.trim().is_empty());
    match tail_agent {
        Some(agent) => Ok(agent),
        None => Ok(research::AgentSpec {
            adapter: crate::adapters::default_fork_adapter(&state.inner.config)?,
            model: None,
            effort: None,
        }),
    }
}

/// What a chain's queue does next (`researchQueueAction`).
enum FollowupStep {
    Wait,
    /// The head node no longer exists: the queue has nothing to continue.
    Clear,
    Send {
        item: QueuedResearchFollowup,
        tail_id: String,
    },
}

fn followup_step_locked(model: &Model, head_id: &str) -> FollowupStep {
    let Some(first) = model
        .research_followups
        .get(head_id)
        .and_then(|queue| queue.first())
    else {
        return FollowupStep::Wait;
    };
    let Some(head) = model.research_nodes.get(head_id) else {
        return FollowupStep::Clear;
    };
    let Some(tree) = model.research_trees.get(&head.tree_id) else {
        return FollowupStep::Clear;
    };
    if tree.archived_at.is_some() || tree.is_trashed() || first.failed_reason.is_some() {
        return FollowupStep::Wait;
    }
    match chain_tail(&model.research_nodes, head_id) {
        ChainTail::Send(tail_id) => FollowupStep::Send {
            item: first.clone(),
            tail_id,
        },
        ChainTail::Wait | ChainTail::Stalled(_) => FollowupStep::Wait,
    }
}

/// One chain's queue as the frontend receives it.
fn followup_views_locked(
    model: &Model,
    tree_id: &str,
    head_id: &str,
) -> Vec<ResearchFollowupQueueItem> {
    model
        .research_followups
        .get(head_id)
        .map(|queue| {
            queue
                .iter()
                .enumerate()
                .map(|(position, item)| ResearchFollowupQueueItem {
                    id: item.id.clone(),
                    tree_id: tree_id.to_string(),
                    head_node_id: head_id.to_string(),
                    message: item.message.clone(),
                    agent: item.agent.clone(),
                    position,
                    created_at: item.created_at,
                    failed_reason: item.failed_reason.clone(),
                })
                .collect()
        })
        .unwrap_or_default()
}

/// A tree's queues, keyed by chain head.
pub(super) fn research_followup_views_for_tree_locked(
    model: &Model,
    tree_id: &str,
) -> HashMap<String, Vec<ResearchFollowupQueueItem>> {
    model
        .research_followups
        .keys()
        .filter(|head_id| {
            model
                .research_nodes
                .get(*head_id)
                .is_some_and(|head| head.tree_id == tree_id)
        })
        .map(|head_id| {
            (
                head_id.clone(),
                followup_views_locked(model, tree_id, head_id),
            )
        })
        .filter(|(_, items)| !items.is_empty())
        .collect()
}

/// Removes the queues whose head matches `remove` (or no longer exists) and
/// returns them, so the caller can release their images.
pub(super) fn drop_research_followups_locked(
    model: &mut Model,
    remove: impl Fn(&ResearchNode) -> bool,
) -> Vec<(String, Vec<QueuedResearchFollowup>)> {
    let heads = model
        .research_followups
        .keys()
        .filter(|head_id| model.research_nodes.get(*head_id).is_none_or(&remove))
        .cloned()
        .collect::<Vec<_>>();
    heads
        .into_iter()
        .filter_map(|head_id| {
            let queue = model.research_followups.remove(&head_id)?;
            Some((head_id, queue))
        })
        .collect()
}

/// The attachments of dropped queues.
pub(super) fn queued_followup_attachments(
    queues: &[(String, Vec<QueuedResearchFollowup>)],
) -> impl Iterator<Item = ResearchMessageAttachment> + '_ {
    queues
        .iter()
        .flat_map(|(_, queue)| queue.iter())
        .flat_map(|item| item.message.attachments.iter().cloned())
}

impl AppState {
    /// Sets what starts the run of a follow-up the queue sends.
    pub fn set_research_followup_launcher(&self, launcher: FollowupLauncher) {
        if let Ok(mut slot) = self.inner.research_followup_launcher.lock() {
            *slot = Some(launcher);
        }
    }

    fn lock_research_followups(&self) -> MutexGuard<'_, ()> {
        self.inner
            .research_followup_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn launch_research_followup(&self, node: &ResearchNode) {
        let launcher = self
            .inner
            .research_followup_launcher
            .lock()
            .ok()
            .and_then(|slot| slot.clone());
        if let Some(launcher) = launcher {
            launcher(self, node);
        }
    }

    /// Emits `research.queue.changed` for the chain headed by `head_id`,
    /// containing the full queue after the change.
    pub(super) fn emit_research_queue_changed(&self, tree_id: &str, head_id: &str) {
        let items = self
            .inner
            .model
            .lock()
            .map(|model| followup_views_locked(&model, tree_id, head_id))
            .unwrap_or_default();
        self.emit(SessionEvent::new(
            "research.queue.changed",
            None,
            None,
            json!({ "treeId": tree_id, "headNodeId": head_id, "items": items }),
        ));
    }

    /// A tree's queues, keyed by chain head, each in send order.
    pub fn research_followups(
        &self,
        tree_id: &str,
    ) -> Result<HashMap<String, Vec<ResearchFollowupQueueItem>>, String> {
        let model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        if !model.research_trees.contains_key(tree_id) {
            return Err(format!("research tree {tree_id} was not found"));
        }
        Ok(research_followup_views_for_tree_locked(&model, tree_id))
    }

    /// Admits a follow-up as the inline child of `tail_id` under the same
    /// workspace checks as a fork. `consumed` names the queued item it
    /// sends, which is removed from the queue with the insertion.
    fn admit_research_followup(
        &self,
        tail_id: &str,
        prompt: String,
        attachments: Vec<ResearchMessageAttachment>,
        agent: Option<research::AgentSpec>,
        consumed: Option<&str>,
    ) -> Result<ResearchNode, String> {
        let _guard = crate::workspace::lock_research_workspace_mutations()?;
        let workspace = self.research_workspace_for_node(tail_id)?;
        crate::workspace::validate_launch_workspace(self, &workspace.id)?;
        self.create_research_child_with_options(
            tail_id,
            prompt,
            None,
            true,
            attachments,
            None,
            agent,
            consumed,
        )
    }

    /// Asks a follow-up at the end of the chain that holds `node_id`: when
    /// nothing is queued for the chain and its last answer can accept a
    /// follow-up, it is sent immediately (and its run started); otherwise it is
    /// added to the chain's queue. Refused in an archived thread or one in
    /// the Trash, and when queued behind a stopped answer.
    pub fn ask_research_followup(
        &self,
        node_id: &str,
        prompt: String,
        attachments: Vec<ResearchMessageAttachment>,
        agent: Option<research::AgentSpec>,
    ) -> Result<ResearchFollowupAsk, String> {
        let prompt = prompt.trim().to_string();
        if prompt.is_empty() {
            return Err("research prompt cannot be empty".to_string());
        }
        crate::tweets::validate_research_message_attachments(&attachments)?;
        let agent = agent.map(chosen_research_agent).transpose()?;
        let lock = self.lock_research_followups();
        enum Decision {
            Send(String),
            Queue(research::AgentSpec, bool),
        }
        let (tree_id, head_id, decision) = {
            let model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            let node = model
                .research_nodes
                .get(node_id)
                .ok_or_else(|| format!("research node {node_id} was not found"))?;
            let tree_id = node.tree_id.clone();
            reject_trashed_research_tree(&model, &tree_id)?;
            if model
                .research_trees
                .get(&tree_id)
                .ok_or_else(|| format!("research tree {tree_id} was not found"))?
                .archived_at
                .is_some()
            {
                return Err("restore archived research before creating a follow-up".to_string());
            }
            let head_id = research_chain_head(&model.research_nodes, node_id);
            let queued = model
                .research_followups
                .get(&head_id)
                .is_some_and(|queue| !queue.is_empty());
            let decision = match (queued, chain_tail(&model.research_nodes, &head_id)) {
                (false, ChainTail::Send(tail_id)) => Decision::Send(tail_id),
                (false, ChainTail::Stalled(message)) => return Err(message.to_string()),
                (_, tail) => Decision::Queue(
                    queued_followup_agent(self, &model, &head_id, agent.clone())?,
                    matches!(tail, ChainTail::Send(_)),
                ),
            };
            (tree_id, head_id, decision)
        };
        match decision {
            Decision::Send(tail_id) => {
                let node =
                    self.admit_research_followup(&tail_id, prompt, attachments, agent, None)?;
                drop(lock);
                self.launch_research_followup(&node);
                Ok(ResearchFollowupAsk::Sent {
                    node,
                    head_node_id: head_id,
                })
            }
            Decision::Queue(agent, tail_ready) => {
                let item = self.append_research_followup(&head_id, prompt, attachments, agent)?;
                drop(lock);
                self.emit_research_queue_changed(&tree_id, &head_id);
                if tail_ready {
                    self.schedule_research_followup_dispatch(Some(&tree_id));
                }
                let item = self
                    .inner
                    .model
                    .lock()
                    .ok()
                    .and_then(|model| {
                        followup_views_locked(&model, &tree_id, &head_id)
                            .into_iter()
                            .find(|view| view.id == item.id)
                    })
                    .ok_or_else(|| "the queued follow-up was not found".to_string())?;
                Ok(ResearchFollowupAsk::Queued {
                    item,
                    head_node_id: head_id,
                })
            }
        }
    }

    /// Adds a follow-up to the end of the queue of the chain `head_id`
    /// heads. Its images move into the image store, referenced by the queue.
    fn append_research_followup(
        &self,
        head_id: &str,
        prompt: String,
        attachments: Vec<ResearchMessageAttachment>,
        agent: research::AgentSpec,
    ) -> Result<QueuedResearchFollowup, String> {
        let root = &self.inner.config.workspace_root;
        crate::research_images::ensure_adapter_reads_images(root, &agent.adapter, &attachments)?;
        let store = crate::research_images::lock_store();
        crate::research_images::ensure_available(root, &attachments)?;
        let item = QueuedResearchFollowup {
            id: self.next_id("research-followup"),
            message: research::UserMessage {
                text: prompt,
                attachments,
            },
            agent,
            created_at: now_millis(),
            failed_reason: None,
        };
        {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            if !model.research_nodes.contains_key(head_id) {
                return Err(format!("research node {head_id} was not found"));
            }
            model
                .research_followups
                .entry(head_id.to_string())
                .or_default()
                .push(item.clone());
        }
        self.persist();
        crate::research_images::commit(
            root,
            crate::research_images::image_ids(&item.message.attachments),
        );
        drop(store);
        Ok(item)
    }

    /// The chain head and tree of the queued item `item_id`, and its index.
    fn find_research_followup(
        model: &Model,
        item_id: &str,
    ) -> Result<(String, String, usize), String> {
        model
            .research_followups
            .iter()
            .find_map(|(head_id, queue)| {
                let index = queue.iter().position(|item| item.id == item_id)?;
                let tree_id = model.research_nodes.get(head_id)?.tree_id.clone();
                Some((head_id.clone(), tree_id, index))
            })
            .ok_or_else(|| format!("queued follow-up {item_id} was not found"))
    }

    /// Removes a queued follow-up; the ones after it move up. Its images are
    /// released. Returns the chain's queue after the change.
    pub fn cancel_research_followup(
        &self,
        item_id: &str,
    ) -> Result<Vec<ResearchFollowupQueueItem>, String> {
        let _lock = self.lock_research_followups();
        let (tree_id, head_id, item) = {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            let (head_id, tree_id, index) = Self::find_research_followup(&model, item_id)?;
            let queue = model
                .research_followups
                .get_mut(&head_id)
                .expect("the queue was found above");
            let item = queue.remove(index);
            if queue.is_empty() {
                model.research_followups.remove(&head_id);
            }
            (tree_id, head_id, item)
        };
        self.persist();
        self.release_research_images(&item.message.attachments);
        self.emit_research_queue_changed(&tree_id, &head_id);
        // Cancelling a failed leading item unblocks the queue.
        self.schedule_research_followup_dispatch(Some(&tree_id));
        self.research_followup_queue(&tree_id, &head_id)
    }

    /// Clears a refused item's reason so the queue sends it again. Refused
    /// while the thread is in the Trash.
    pub fn retry_research_followup(
        &self,
        item_id: &str,
    ) -> Result<Vec<ResearchFollowupQueueItem>, String> {
        let _lock = self.lock_research_followups();
        let (tree_id, head_id) = {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            let (head_id, tree_id, index) = Self::find_research_followup(&model, item_id)?;
            reject_trashed_research_tree(&model, &tree_id)?;
            model
                .research_followups
                .get_mut(&head_id)
                .expect("the queue was found above")[index]
                .failed_reason = None;
            (tree_id, head_id)
        };
        self.persist();
        self.emit_research_queue_changed(&tree_id, &head_id);
        self.schedule_research_followup_dispatch(Some(&tree_id));
        self.research_followup_queue(&tree_id, &head_id)
    }

    fn research_followup_queue(
        &self,
        tree_id: &str,
        head_id: &str,
    ) -> Result<Vec<ResearchFollowupQueueItem>, String> {
        let model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        Ok(followup_views_locked(&model, tree_id, head_id))
    }

    /// Moves the queue of the chain `from` heads to `to`: an edited first
    /// question of a branch returns the queue to the question it was to
    /// replace when the replacement is rolled back.
    pub fn move_research_followups(&self, from: &str, to: &str) {
        let tree_id = {
            let Ok(mut model) = self.inner.model.lock() else {
                return;
            };
            let Some(queue) = model.research_followups.remove(from) else {
                return;
            };
            let Some(tree_id) = model
                .research_nodes
                .get(to)
                .map(|node| node.tree_id.clone())
            else {
                model.research_followups.insert(from.to_string(), queue);
                return;
            };
            model.research_followups.insert(to.to_string(), queue);
            tree_id
        };
        self.persist();
        self.emit_research_queue_changed(&tree_id, from);
        self.emit_research_queue_changed(&tree_id, to);
    }

    /// Imports queued follow-ups that earlier builds kept in the
    /// webview's storage. Items whose id is already queued are skipped, so a
    /// second import (another window, a retry after a failed request) adds
    /// nothing; items whose chain no longer exists are dropped. An item whose images
    /// are no longer stored is kept without them, marked as not sent.
    /// Returns how many items were added.
    pub fn import_research_followups(
        &self,
        mut items: Vec<LegacyQueuedResearchFollowup>,
    ) -> Result<usize, String> {
        items.sort_by(|left, right| {
            left.created_at
                .total_cmp(&right.created_at)
                .then_with(|| left.id.cmp(&right.id))
        });
        let root = self.inner.config.workspace_root.clone();
        let _lock = self.lock_research_followups();
        let store = crate::research_images::lock_store();
        let mut touched = Vec::<(String, String)>::new();
        let mut added = Vec::<QueuedResearchFollowup>::new();
        {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            let mut known = model
                .research_followups
                .values()
                .flatten()
                .map(|item| item.id.clone())
                .collect::<HashSet<_>>();
            for legacy in items {
                let prompt = legacy.prompt.trim().to_string();
                if prompt.is_empty()
                    || legacy.id.trim().is_empty()
                    || !known.insert(legacy.id.clone())
                {
                    continue;
                }
                let Some(tree_id) = model
                    .research_nodes
                    .get(&legacy.head_node_id)
                    .map(|node| node.tree_id.clone())
                else {
                    continue;
                };
                let head_id = research_chain_head(&model.research_nodes, &legacy.head_node_id);
                let Ok(agent) = queued_followup_agent(self, &model, &head_id, None) else {
                    continue;
                };
                let inputs = legacy
                    .images
                    .iter()
                    .map(|image| crate::research_images::ImageInput {
                        id: image.id.clone(),
                        file_name: image.file_name.clone(),
                    })
                    .collect::<Vec<_>>();
                let images = crate::research_images::attachments_for_inputs(&root, &inputs)
                    .ok()
                    .filter(|images| {
                        crate::research_images::ensure_available(&root, images).is_ok()
                    });
                let failed_reason = images
                    .is_none()
                    .then(|| MIGRATED_IMAGES_MISSING.to_string());
                let mut attachments = legacy.attachments;
                attachments.extend(images.unwrap_or_default());
                if crate::tweets::validate_research_message_attachments(&attachments).is_err() {
                    attachments.retain(|attachment| {
                        matches!(attachment, ResearchMessageAttachment::Image { .. })
                    });
                }
                let created_at = if legacy.created_at.is_finite() && legacy.created_at > 0.0 {
                    legacy.created_at as u128
                } else {
                    now_millis()
                };
                let item = QueuedResearchFollowup {
                    id: legacy.id,
                    message: research::UserMessage {
                        text: prompt,
                        attachments,
                    },
                    agent,
                    created_at,
                    failed_reason,
                };
                model
                    .research_followups
                    .entry(head_id.clone())
                    .or_default()
                    .push(item.clone());
                added.push(item);
                if !touched.contains(&(tree_id.clone(), head_id.clone())) {
                    touched.push((tree_id, head_id));
                }
            }
        }
        if added.is_empty() {
            return Ok(0);
        }
        self.persist();
        crate::research_images::commit(
            &root,
            added
                .iter()
                .flat_map(|item| crate::research_images::image_ids(&item.message.attachments)),
        );
        drop(store);
        for (tree_id, head_id) in &touched {
            self.emit_research_queue_changed(tree_id, head_id);
        }
        self.schedule_research_followup_dispatch(None);
        Ok(added.len())
    }

    /// Runs `dispatch_research_followups` off the caller's thread: callers
    /// are run settlement and mutations that may hold locks needed for dispatch.
    /// Tests record the request and run it with
    /// `run_scheduled_research_followup_dispatches`.
    pub(crate) fn schedule_research_followup_dispatch(&self, tree_id: Option<&str>) {
        #[cfg(test)]
        {
            if let Ok(mut scheduled) = self.inner.scheduled_followup_dispatches.lock() {
                scheduled.push(tree_id.map(str::to_string));
            }
        }
        #[cfg(not(test))]
        {
            let state = self.clone();
            let tree_id = tree_id.map(str::to_string);
            std::thread::spawn(move || {
                state.dispatch_research_followups(tree_id.as_deref());
            });
        }
    }

    #[cfg(test)]
    pub(crate) fn run_scheduled_research_followup_dispatches(&self) -> Vec<ResearchNode> {
        let scheduled =
            std::mem::take(&mut *self.inner.scheduled_followup_dispatches.lock().unwrap());
        scheduled
            .into_iter()
            .flat_map(|tree_id| self.dispatch_research_followups(tree_id.as_deref()))
            .collect()
    }

    /// Sends the first queued follow-up of every chain (of one tree, or of
    /// all) eligible to run, and starts their execution. Returns the nodes
    /// admitted.
    pub fn dispatch_research_followups(&self, tree_id: Option<&str>) -> Vec<ResearchNode> {
        let admitted = {
            let _lock = self.lock_research_followups();
            let heads = match self.inner.model.lock() {
                Ok(model) => {
                    let mut heads = model
                        .research_followups
                        .keys()
                        .filter(|head_id| {
                            tree_id.is_none_or(|tree_id| {
                                model
                                    .research_nodes
                                    .get(*head_id)
                                    .is_none_or(|head| head.tree_id == tree_id)
                            })
                        })
                        .cloned()
                        .collect::<Vec<_>>();
                    heads.sort();
                    heads
                }
                Err(_) => return Vec::new(),
            };
            heads
                .iter()
                .filter_map(|head_id| self.dispatch_research_followup_chain(head_id))
                .collect::<Vec<_>>()
        };
        // Launch outside the queue lock: a launch that fails settles its node,
        // which schedules another dispatch.
        for node in &admitted {
            self.launch_research_followup(node);
        }
        admitted
    }

    fn dispatch_research_followup_chain(&self, head_id: &str) -> Option<ResearchNode> {
        let step = {
            let model = self.inner.model.lock().ok()?;
            followup_step_locked(&model, head_id)
        };
        match step {
            FollowupStep::Wait => None,
            FollowupStep::Clear => {
                let dropped = {
                    let mut model = self.inner.model.lock().ok()?;
                    model
                        .research_followups
                        .remove(head_id)
                        .map(|queue| vec![(head_id.to_string(), queue)])
                        .unwrap_or_default()
                };
                if !dropped.is_empty() {
                    self.persist();
                    self.release_research_images(
                        &queued_followup_attachments(&dropped).collect::<Vec<_>>(),
                    );
                }
                None
            }
            FollowupStep::Send { item, tail_id } => {
                match self.admit_research_followup(
                    &tail_id,
                    item.message.text.clone(),
                    item.message.attachments.clone(),
                    Some(item.agent.clone()),
                    Some(&item.id),
                ) {
                    Ok(node) => {
                        self.emit_research_queue_changed(&node.tree_id, head_id);
                        Some(node)
                    }
                    Err(err) => {
                        // A refusal that still applies to the same item and
                        // tail would refuse every later attempt too, so it is
                        // recorded on the item; a chain that changed is read
                        // again by the next dispatch.
                        let still = {
                            let model = self.inner.model.lock().ok()?;
                            match followup_step_locked(&model, head_id) {
                                FollowupStep::Send {
                                    item: again,
                                    tail_id: again_tail,
                                } => again.id == item.id && again_tail == tail_id,
                                _ => false,
                            }
                            .then(|| {
                                model
                                    .research_nodes
                                    .get(head_id)
                                    .map(|head| head.tree_id.clone())
                            })
                            .flatten()
                        };
                        match still {
                            Some(tree_id) => {
                                self.mark_research_followup_failed(&tree_id, head_id, &item.id, err)
                            }
                            None => eprintln!(
                                "session: queued follow-up {} not sent; its chain changed: {err}",
                                item.id
                            ),
                        }
                        None
                    }
                }
            }
        }
    }

    fn mark_research_followup_failed(
        &self,
        tree_id: &str,
        head_id: &str,
        item_id: &str,
        reason: String,
    ) {
        let marked = self.inner.model.lock().is_ok_and(|mut model| {
            model
                .research_followups
                .get_mut(head_id)
                .and_then(|queue| queue.iter_mut().find(|item| item.id == item_id))
                .map(|item| item.failed_reason = Some(reason))
                .is_some()
        });
        if marked {
            self.persist();
            self.emit_research_queue_changed(tree_id, head_id);
        }
    }
}
