// Tests of the follow-up queue (`state::research_followups`). A child of
// `state::tests`, for its fixtures.

use super::*;
use crate::state::ResearchFollowupAsk;
use crate::tweets::ResearchMessageAttachment;

/// A state whose research workspace is a real directory, so admission's
/// workspace checks pass.
fn queue_state(workspace: &std::path::Path) -> AppState {
    let state = AppState::new(test_config(workspace.to_path_buf()));
    state.restore_session();
    let mut group = sample_group();
    group.dir = workspace.display().to_string();
    state.insert_group_after(group, None).unwrap();
    state
}

fn queued(ask: ResearchFollowupAsk) -> research::ResearchFollowupQueueItem {
    match ask {
        ResearchFollowupAsk::Queued { item, .. } => item,
        ResearchFollowupAsk::Sent { node, .. } => {
            panic!("expected a queued item, sent {}", node.id)
        }
    }
}

fn queue_texts(state: &AppState, tree_id: &str, head_id: &str) -> Vec<String> {
    state
        .research_followups(tree_id)
        .unwrap()
        .remove(head_id)
        .unwrap_or_default()
        .into_iter()
        .map(|item| item.message.text)
        .collect()
}

fn queue_events(state: &AppState) -> Vec<serde_json::Value> {
    state
        .take_emitted_events()
        .into_iter()
        .filter(|event| event.event_type == "research.queue.changed")
        .map(|event| event.payload)
        .collect()
}

fn inline_child_of(state: &AppState, parent_id: &str) -> Option<ResearchNode> {
    let model = state.inner.model.lock().unwrap();
    model
        .research_nodes
        .values()
        .find(|node| node.parent_node_id.as_deref() == Some(parent_id) && node.inline)
        .cloned()
}

/// Settles a run as the SDK runtime does when an answer completes, with a
/// recorded checkpoint.
fn finish_with_answer(state: &AppState, node_id: &str) {
    let agent = sample_agent(&format!("agent-{node_id}"));
    state.insert_agent(agent.clone()).unwrap();
    state.bind_research_node_harness(node_id, &agent).unwrap();
    let mut turn = sample_user_turn(&agent.id, "answer");
    turn.role = "assistant".to_string();
    state.append_harness_turn(turn).unwrap();
    {
        let mut model = state.inner.model.lock().unwrap();
        let node = model.research_nodes.get_mut(node_id).unwrap();
        node.binding_mut().unwrap().native_session_id = Some(format!("session-{node_id}"));
    }
    state
        .finish_research_sdk_run(node_id, &agent.id, true, None)
        .unwrap();
}

fn png_image(workspace: &std::path::Path) -> ResearchMessageAttachment {
    let png = b"\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR\0\0\0\x02\0\0\0\x02\x08\x06\0\0\0".to_vec();
    crate::research_images::save_pending(workspace, &png, Some("shot.png")).unwrap()
}

fn image_id(attachment: &ResearchMessageAttachment) -> String {
    match attachment {
        ResearchMessageAttachment::Image { id, .. } => id.clone(),
        _ => unreachable!(),
    }
}

#[test]
fn follow_ups_queue_behind_a_running_answer_and_send_in_order() {
    let workspace = temp_workspace();
    let state = queue_state(&workspace);
    let detail = state
        .create_research_tree(research_root_request("Root"))
        .unwrap();
    let tree_id = detail.tree.id.clone();
    let root_id = detail.tree.root_node_id.clone();
    state.take_emitted_events();

    // The root is still queued: both questions remain queued in order.
    let first = queued(
        state
            .ask_research_followup(&root_id, " First ".to_string(), Vec::new(), None)
            .unwrap(),
    );
    assert_eq!(first.message.text, "First");
    assert_eq!(first.head_node_id, root_id);
    assert_eq!(first.position, 0);
    assert_eq!(first.agent.adapter, "claude");
    let second = queued(
        state
            .ask_research_followup(&root_id, "Second".to_string(), Vec::new(), None)
            .unwrap(),
    );
    assert_eq!(second.position, 1);
    let events = queue_events(&state);
    assert_eq!(events.len(), 2);
    assert_eq!(events[1]["treeId"], json!(tree_id));
    assert_eq!(events[1]["headNodeId"], json!(root_id));
    assert_eq!(events[1]["items"][1]["message"]["text"], json!("Second"));
    assert_eq!(events[1]["items"][0]["failedReason"], json!(null));
    assert_eq!(
        state.research_tree(&tree_id).unwrap().queues[&root_id].len(),
        2
    );

    // Nothing is sent while the chain's last answer runs.
    assert!(state.dispatch_research_followups(Some(&tree_id)).is_empty());

    // The answer completes: the first question becomes its inline child and
    // leaves the queue; the second remains queued for that answer.
    settle_research_node(&state, &root_id);
    let sent = state.dispatch_research_followups(Some(&tree_id));
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].prompt(), "First");
    assert_eq!(sent[0].parent_node_id.as_deref(), Some(root_id.as_str()));
    assert!(sent[0].inline);
    assert_eq!(queue_texts(&state, &tree_id, &root_id), vec!["Second"]);
    assert!(state.dispatch_research_followups(Some(&tree_id)).is_empty());

    // A run that settles schedules a dispatch of its tree.
    state.run_scheduled_research_followup_dispatches();
    finish_with_answer(&state, &sent[0].id);
    assert_eq!(
        state.research_node(&sent[0].id).unwrap().status(),
        ResearchNodeStatus::Complete
    );
    let sent_again = state.run_scheduled_research_followup_dispatches();
    assert_eq!(sent_again.len(), 1);
    assert_eq!(sent_again[0].prompt(), "Second");
    assert_eq!(
        sent_again[0].parent_node_id.as_deref(),
        Some(sent[0].id.as_str())
    );
    assert!(state.research_followups(&tree_id).unwrap().is_empty());
    let events = queue_events(&state);
    assert_eq!(events.last().unwrap()["items"], json!([]));

    // The persisted state no longer holds the queue.
    let saved: serde_json::Value =
        serde_json::from_slice(&std::fs::read(persistence::state_path(&workspace)).unwrap())
            .unwrap();
    assert!(saved.get("researchFollowups").is_none());
    std::fs::remove_dir_all(workspace).ok();
}

#[test]
fn a_follow_up_to_a_free_chain_is_sent_at_once_and_a_stalled_chain_refuses_it() {
    let workspace = temp_workspace();
    let state = queue_state(&workspace);
    let detail = state
        .create_research_tree(research_root_request("Root"))
        .unwrap();
    let tree_id = detail.tree.id.clone();
    let root_id = detail.tree.root_node_id.clone();
    settle_research_node(&state, &root_id);

    let ResearchFollowupAsk::Sent { node, head_node_id } = state
        .ask_research_followup(&root_id, "Now".to_string(), Vec::new(), None)
        .unwrap()
    else {
        panic!("expected a send");
    };
    assert_eq!(head_node_id, root_id);
    assert_eq!(node.parent_node_id.as_deref(), Some(root_id.as_str()));
    assert!(node.inline);
    assert!(state.research_followups(&tree_id).unwrap().is_empty());

    // Sent from any message of the chain, a question joins the chain's
    // queue under its head.
    let item = queued(
        state
            .ask_research_followup(&node.id, "Later".to_string(), Vec::new(), None)
            .unwrap(),
    );
    assert_eq!(item.head_node_id, root_id);
    state.cancel_research_followup(&item.id).unwrap();

    // With nothing queued, a question behind an answer that stopped is
    // refused with the ask box's note.
    state
        .fail_research_node(&node.id, "boom".to_string())
        .unwrap();
    assert_eq!(
        state
            .ask_research_followup(&root_id, "After".to_string(), Vec::new(), None)
            .unwrap_err(),
        "The last answer stopped with an error. Retry it or edit its question to continue."
    );
    {
        let mut model = state.inner.model.lock().unwrap();
        let run = model
            .research_nodes
            .get_mut(&node.id)
            .unwrap()
            .run_mut()
            .unwrap();
        run.status = ResearchNodeStatus::Cancelled;
    }
    assert_eq!(
        state
            .ask_research_followup(&root_id, "After".to_string(), Vec::new(), None)
            .unwrap_err(),
        "The last answer was stopped. Run it again to continue."
    );

    // Archived and trashed threads reject questions.
    state.remove_research_branch(&node.id).unwrap();
    state.archive_research_tree(&tree_id).unwrap();
    assert!(
        state
            .ask_research_followup(&root_id, "Archived".to_string(), Vec::new(), None)
            .unwrap_err()
            .contains("restore archived research")
    );
    state.restore_research_tree(&tree_id).unwrap();
    state.trash_research_tree(&tree_id).unwrap();
    assert!(
        state
            .ask_research_followup(&root_id, "Trashed".to_string(), Vec::new(), None)
            .unwrap_err()
            .contains("Trash")
    );
    std::fs::remove_dir_all(workspace).ok();
}

#[test]
fn a_refused_send_waits_until_retried_and_archived_or_trashed_threads_wait() {
    let workspace = temp_workspace();
    let state = queue_state(&workspace);
    let detail = state
        .create_research_tree(research_root_request("Root"))
        .unwrap();
    let tree_id = detail.tree.id.clone();
    let root_id = detail.tree.root_node_id.clone();
    let first = queued(
        state
            .ask_research_followup(&root_id, "First".to_string(), Vec::new(), None)
            .unwrap(),
    );
    queued(
        state
            .ask_research_followup(&root_id, "Second".to_string(), Vec::new(), None)
            .unwrap(),
    );
    settle_research_node(&state, &root_id);

    // An archived thread's queue does not dispatch; unarchiving dispatches it.
    state.archive_research_tree(&tree_id).unwrap();
    assert!(state.dispatch_research_followups(None).is_empty());
    state.take_emitted_events();

    // The workspace folder is gone: the send is rejected, the reason is
    // recorded on the item, and subsequent queue items remain blocked.
    let missing_dir = {
        let mut model = state.inner.model.lock().unwrap();
        let group = model.groups.get_mut("group-1").unwrap();
        group.dir = workspace.join("missing").display().to_string();
        group.dir.clone()
    };
    state.restore_research_tree(&tree_id).unwrap();
    assert!(
        state
            .run_scheduled_research_followup_dispatches()
            .is_empty()
    );
    let queue = state
        .research_followups(&tree_id)
        .unwrap()
        .remove(&root_id)
        .unwrap();
    assert_eq!(queue.len(), 2);
    assert!(
        queue[0]
            .failed_reason
            .as_deref()
            .is_some_and(|reason| reason.contains("unavailable")),
        "{:?}",
        queue[0].failed_reason
    );
    assert_eq!(queue[1].failed_reason, None);
    assert!(queue_events(&state).last().unwrap()["items"][0]["failedReason"].is_string());
    assert!(state.dispatch_research_followups(None).is_empty());

    // The folder is restored: Retry clears the reason and the item is sent.
    std::fs::create_dir_all(&missing_dir).unwrap();
    let after_retry = state.retry_research_followup(&first.id).unwrap();
    assert_eq!(after_retry[0].failed_reason, None);
    let sent = state.run_scheduled_research_followup_dispatches();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].prompt(), "First");

    // A thread in the Trash does not dispatch, and Retry is rejected there.
    settle_research_node(&state, &sent[0].id);
    state.trash_research_tree(&tree_id).unwrap();
    assert!(state.dispatch_research_followups(None).is_empty());
    let second_id = state.research_followups(&tree_id).unwrap()[&root_id][0]
        .id
        .clone();
    assert!(
        state
            .retry_research_followup(&second_id)
            .unwrap_err()
            .contains("Trash")
    );
    state.restore_research_tree_from_trash(&tree_id).unwrap();
    let sent = state.run_scheduled_research_followup_dispatches();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].prompt(), "Second");
    std::fs::remove_dir_all(workspace).ok();
}

#[test]
fn queued_images_stay_stored_until_cancelled_and_the_next_item_moves_up() {
    let workspace = temp_workspace();
    let state = queue_state(&workspace);
    let detail = state
        .create_research_tree(research_root_request("Root"))
        .unwrap();
    let tree_id = detail.tree.id.clone();
    let root_id = detail.tree.root_node_id.clone();
    let stored = |id: &str| {
        crate::research_images::store_dir(&workspace)
            .join(id)
            .is_file()
    };
    let pending = |id: &str| {
        crate::research_images::store_dir(&workspace)
            .join("pending")
            .join(id)
            .is_file()
    };

    let image = png_image(&workspace);
    let id = image_id(&image);
    let first = queued(
        state
            .ask_research_followup(&root_id, "With image".to_string(), vec![image], None)
            .unwrap(),
    );
    assert!(stored(&id) && !pending(&id));
    assert!(state.research_image_ids_in_use().unwrap().contains(&id));
    queued(
        state
            .ask_research_followup(&root_id, "Next".to_string(), Vec::new(), None)
            .unwrap(),
    );

    // Cancel releases the image (back to pending: it is younger than a day)
    // and the next question advances in the queue.
    let queue = state.cancel_research_followup(&first.id).unwrap();
    assert_eq!(queue.len(), 1);
    assert_eq!(queue[0].message.text, "Next");
    assert_eq!(queue[0].position, 0);
    assert!(pending(&id) && !stored(&id));
    assert!(state.cancel_research_followup(&first.id).is_err());

    // A sent question transfers its image to the node.
    let image = png_image(&workspace);
    let id = image_id(&image);
    state
        .ask_research_followup(&root_id, "Image later".to_string(), vec![image], None)
        .unwrap();
    settle_research_node(&state, &root_id);
    let sent = state.dispatch_research_followups(Some(&tree_id));
    settle_research_node(&state, &sent[0].id);
    let sent = state.dispatch_research_followups(Some(&tree_id));
    assert_eq!(sent[0].prompt(), "Image later");
    assert_eq!(image_id(&sent[0].attachments()[0]), id);
    assert!(stored(&id));
    std::fs::remove_dir_all(workspace).ok();
}

#[test]
fn removing_a_chain_head_drops_its_queue_and_an_edited_branch_head_keeps_it() {
    let workspace = temp_workspace();
    let state = queue_state(&workspace);
    let detail = state
        .create_research_tree(research_root_request("Root"))
        .unwrap();
    let tree_id = detail.tree.id.clone();
    let root_id = detail.tree.root_node_id.clone();
    settle_research_node(&state, &root_id);
    let branch = state
        .create_research_child(&root_id, "Branch".to_string(), None, false)
        .unwrap();
    let image = png_image(&workspace);
    let id = image_id(&image);
    queued(
        state
            .ask_research_followup(&branch.id, "Queued".to_string(), vec![image], None)
            .unwrap(),
    );

    // The branch question fails and is edited: the replacement question heads the
    // branch and retains its queue.
    state
        .fail_research_node(&branch.id, "boom".to_string())
        .unwrap();
    let edited = state
        .create_research_child_replacing(
            &root_id,
            "Edited".to_string(),
            None,
            false,
            Vec::new(),
            &branch.id,
            None,
        )
        .unwrap();
    state.remove_research_branch(&branch.id).unwrap();
    assert_eq!(queue_texts(&state, &tree_id, &edited.id), vec!["Queued"]);
    assert!(queue_texts(&state, &tree_id, &branch.id).is_empty());

    // Removing the branch drops the queue and releases its image.
    state
        .fail_research_node(&edited.id, "boom".to_string())
        .unwrap();
    state.take_emitted_events();
    state.remove_research_branch(&edited.id).unwrap();
    assert!(state.research_followups(&tree_id).unwrap().is_empty());
    let events = queue_events(&state);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["headNodeId"], json!(edited.id));
    assert_eq!(events[0]["items"], json!([]));
    assert!(!state.research_image_ids_in_use().unwrap().contains(&id));

    // Deleting the thread drops the queues of its chains.
    queued(
        state
            .ask_research_followup(
                &state
                    .create_research_child(&root_id, "Another".to_string(), None, false)
                    .unwrap()
                    .id,
                "Queued again".to_string(),
                Vec::new(),
                None,
            )
            .unwrap(),
    );
    {
        let mut model = state.inner.model.lock().unwrap();
        for node in model.research_nodes.values_mut() {
            if let Some(run) = node.run_mut() {
                run.status = ResearchNodeStatus::Failed;
            }
        }
    }
    state.remove_research_tree(&tree_id).unwrap();
    assert!(
        state
            .inner
            .model
            .lock()
            .unwrap()
            .research_followups
            .is_empty()
    );
    std::fs::remove_dir_all(workspace).ok();
}

#[test]
fn queues_survive_a_restart_and_startup_dispatch_sends_them() {
    let workspace = temp_workspace();
    let state = queue_state(&workspace);
    let detail = state
        .create_research_tree(research_root_request("Root"))
        .unwrap();
    let tree_id = detail.tree.id.clone();
    let root_id = detail.tree.root_node_id.clone();
    let image = png_image(&workspace);
    let id = image_id(&image);
    queued(
        state
            .ask_research_followup(&root_id, "After restart".to_string(), vec![image], None)
            .unwrap(),
    );
    // The root completed, but the app exited before the queue dispatched.
    settle_research_node(&state, &root_id);
    state.persist_now();
    state.finalize_persistence_for_exit();
    drop(state);

    let saved: serde_json::Value =
        serde_json::from_slice(&std::fs::read(persistence::state_path(&workspace)).unwrap())
            .unwrap();
    assert_eq!(saved["version"], persistence::STATE_VERSION);
    assert_eq!(
        saved["researchFollowups"][&root_id][0]["message"]["text"],
        json!("After restart")
    );

    // A queue whose head node no longer exists is dropped at load.
    let mut edited = saved.clone();
    edited["researchFollowups"]["research-node-missing"] =
        saved["researchFollowups"][&root_id].clone();
    std::fs::write(
        persistence::state_path(&workspace),
        serde_json::to_vec(&edited).unwrap(),
    )
    .unwrap();

    let restarted = AppState::new(test_config(workspace.clone()));
    restarted.restore_session();
    // The queue still references its image, so the startup sweep keeps it
    // stored.
    assert!(
        crate::research_images::store_dir(&workspace)
            .join(&id)
            .is_file()
    );
    {
        let model = restarted.inner.model.lock().unwrap();
        assert_eq!(
            model.research_followups.keys().collect::<Vec<_>>(),
            vec![&root_id]
        );
    }
    let sent = restarted.dispatch_research_followups(None);
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].tree_id, tree_id);
    assert_eq!(sent[0].prompt(), "After restart");
    assert!(inline_child_of(&restarted, &root_id).is_some());
    restarted.finalize_persistence_for_exit();
    std::fs::remove_dir_all(workspace).ok();
}

#[test]
fn legacy_queues_from_the_webview_are_imported_once() {
    let workspace = temp_workspace();
    let state = queue_state(&workspace);
    let detail = state
        .create_research_tree(research_root_request("Root"))
        .unwrap();
    let tree_id = detail.tree.id.clone();
    let root_id = detail.tree.root_node_id.clone();
    settle_research_node(&state, &root_id);
    let first = state
        .create_research_child(&root_id, "Running".to_string(), None, true)
        .unwrap();
    let image = png_image(&workspace);
    let id = image_id(&image);
    let legacy = |item_id: &str, head: &str, prompt: &str, created_at: f64, images: Vec<String>| {
        LegacyQueuedResearchFollowup {
            id: item_id.to_string(),
            head_node_id: head.to_string(),
            prompt: prompt.to_string(),
            created_at,
            images: images
                .into_iter()
                .map(
                    |id| crate::state::research_followups::LegacyQueuedResearchFollowupImage {
                        id,
                        file_name: Some("shot.png".to_string()),
                    },
                )
                .collect(),
            attachments: Vec::new(),
        }
    };
    let items = vec![
        legacy("q-b", &root_id, "Second", 20.0, Vec::new()),
        legacy("q-a", &root_id, "First", 10.0, vec![id.clone()]),
        legacy(
            "q-c",
            &root_id,
            "Image gone",
            30.0,
            vec!["0123456789abcdef0123456789abcdef.png".to_string()],
        ),
        legacy("q-d", "research-node-gone", "Orphan", 5.0, Vec::new()),
        legacy("q-e", &root_id, "   ", 40.0, Vec::new()),
    ];
    assert_eq!(state.import_research_followups(items.clone()).unwrap(), 3);
    let queue = state
        .research_followups(&tree_id)
        .unwrap()
        .remove(&root_id)
        .unwrap();
    assert_eq!(
        queue
            .iter()
            .map(|item| item.id.as_str())
            .collect::<Vec<_>>(),
        vec!["q-a", "q-b", "q-c"]
    );
    assert_eq!(queue[0].created_at, 10);
    assert_eq!(image_id(&queue[0].message.attachments[0]), id);
    assert!(
        crate::research_images::store_dir(&workspace)
            .join(&id)
            .is_file()
    );
    assert_eq!(queue[0].failed_reason, None);
    assert!(queue[2].message.attachments.is_empty());
    assert!(queue[2].failed_reason.is_some());
    assert_eq!(queue[0].agent.adapter, "claude");

    // A second import (another window, or a retried request) adds nothing.
    assert_eq!(state.import_research_followups(items).unwrap(), 0);
    assert_eq!(
        state.research_followups(&tree_id).unwrap()[&root_id].len(),
        3
    );

    // The imported queue sends once the previous turn completes.
    settle_research_node(&state, &first.id);
    let sent = state.run_scheduled_research_followup_dispatches();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].prompt(), "First");
    assert_eq!(sent[0].parent_node_id.as_deref(), Some(first.id.as_str()));
    std::fs::remove_dir_all(workspace).ok();
}
