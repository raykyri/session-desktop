CREATE TABLE `backfills` (
	`id` text PRIMARY KEY NOT NULL,
	`applied_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tree_invites` (
	`id` text PRIMARY KEY NOT NULL,
	`tree_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`role` text NOT NULL,
	`github_login` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`accepted_by` text,
	`accepted_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`tree_id`) REFERENCES `trees`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`accepted_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tree_invites_token_hash_unique` ON `tree_invites` (`token_hash`);--> statement-breakpoint
CREATE INDEX `tree_invites_tree_idx` ON `tree_invites` (`tree_id`);--> statement-breakpoint
CREATE TABLE `tree_member_removals` (
	`tree_id` text NOT NULL,
	`user_id` text NOT NULL,
	`removed_by` text,
	`removed_at` integer NOT NULL,
	PRIMARY KEY(`tree_id`, `user_id`),
	FOREIGN KEY (`tree_id`) REFERENCES `trees`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`removed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `tree_members` (
	`tree_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`invited_by` text,
	`created_at` integer NOT NULL,
	`archived_at` integer,
	`trashed_at` integer,
	`folder_id` text,
	PRIMARY KEY(`tree_id`, `user_id`),
	FOREIGN KEY (`tree_id`) REFERENCES `trees`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`invited_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`folder_id`) REFERENCES `folders`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `tree_members_user_idx` ON `tree_members` (`user_id`);--> statement-breakpoint
CREATE INDEX `tree_members_folder_idx` ON `tree_members` (`folder_id`);--> statement-breakpoint
CREATE TABLE `tree_subscriptions` (
	`user_id` text NOT NULL,
	`tree_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `tree_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tree_id`) REFERENCES `trees`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `tree_subscriptions_tree_idx` ON `tree_subscriptions` (`tree_id`);--> statement-breakpoint
CREATE TABLE `interface_drafts` (
	`user_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `key`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `research_drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`prompt` text NOT NULL,
	`attachments_json` text DEFAULT '[]' NOT NULL,
	`position` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `research_drafts_order_idx` ON `research_drafts` (`user_id`,`workspace_id`,`position`);--> statement-breakpoint
CREATE TABLE `embed_assets` (
	`hash` text PRIMARY KEY NOT NULL,
	`source_url` text NOT NULL,
	`content_type` text,
	`bytes` integer NOT NULL,
	`stored_at` integer,
	`last_access_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `embed_assets_access_idx` ON `embed_assets` (`last_access_at`);--> statement-breakpoint
CREATE TABLE `collapsed_groups` (
	`user_id` text NOT NULL,
	`tree_id` text NOT NULL,
	PRIMARY KEY(`user_id`, `tree_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tree_id`) REFERENCES `trees`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `collapsed_groups_tree_idx` ON `collapsed_groups` (`tree_id`);--> statement-breakpoint
CREATE TABLE `collapsed_places` (
	`user_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`place_id` text NOT NULL,
	PRIMARY KEY(`user_id`, `workspace_id`, `place_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `folders` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`position` integer NOT NULL,
	`created_at` integer NOT NULL,
	`trashed_at` integer,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `folders_workspace_idx` ON `folders` (`owner_id`,`workspace_id`,`position`);--> statement-breakpoint
CREATE TABLE `tree_folder_membership` (
	`tree_id` text PRIMARY KEY NOT NULL,
	`folder_id` text,
	`system_place` text,
	FOREIGN KEY (`tree_id`) REFERENCES `trees`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`folder_id`) REFERENCES `folders`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "tree_folder_membership_place_ck" CHECK(("tree_folder_membership"."folder_id" IS NULL) <> ("tree_folder_membership"."system_place" IS NULL))
);
--> statement-breakpoint
CREATE INDEX `tree_folder_membership_folder_idx` ON `tree_folder_membership` (`folder_id`);--> statement-breakpoint
CREATE TABLE `feed_items` (
	`id` text PRIMARY KEY NOT NULL,
	`author_id` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`source_rank` integer NOT NULL,
	`node_id` text,
	`tree_id` text,
	`workspace_id` text,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tree_id`) REFERENCES `trees`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `feed_items_order_idx` ON `feed_items` ("occurred_at" desc,"source_rank" desc,"id" desc);--> statement-breakpoint
CREATE INDEX `feed_items_author_idx` ON `feed_items` (`author_id`,"occurred_at" desc);--> statement-breakpoint
CREATE UNIQUE INDEX `feed_items_node_uq` ON `feed_items` (`node_id`);--> statement-breakpoint
CREATE INDEX `feed_items_tree_idx` ON `feed_items` (`tree_id`);--> statement-breakpoint
CREATE TABLE `followup_queue` (
	`id` text PRIMARY KEY NOT NULL,
	`tree_id` text NOT NULL,
	`head_node_id` text NOT NULL,
	`author_id` text NOT NULL,
	`message_json` text NOT NULL,
	`model` text NOT NULL,
	`effort` text,
	`position` integer NOT NULL,
	`created_at` integer NOT NULL,
	`failed_reason` text,
	FOREIGN KEY (`tree_id`) REFERENCES `trees`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`head_node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `followup_queue_head_idx` ON `followup_queue` (`head_node_id`,`position`);--> statement-breakpoint
CREATE INDEX `followup_queue_tree_idx` ON `followup_queue` (`tree_id`);--> statement-breakpoint
CREATE INDEX `followup_queue_author_idx` ON `followup_queue` (`author_id`);--> statement-breakpoint
CREATE TABLE `highlights` (
	`id` text PRIMARY KEY NOT NULL,
	`author_id` text,
	`node_id` text NOT NULL,
	`anchor_json` text NOT NULL,
	`response_revision` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `highlights_node_idx` ON `highlights` (`node_id`);--> statement-breakpoint
CREATE INDEX `highlights_author_idx` ON `highlights` (`author_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `research_images` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`sha256` text NOT NULL,
	`mime` text NOT NULL,
	`byte_size` integer NOT NULL,
	`width` integer,
	`height` integer,
	`file_name` text,
	`storage_path` text NOT NULL,
	`created_at` integer NOT NULL,
	`attached_at` integer,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `research_images_owner_idx` ON `research_images` (`owner_id`,`sha256`);--> statement-breakpoint
CREATE INDEX `research_images_unattached_idx` ON `research_images` (`attached_at`,`created_at`);--> statement-breakpoint
CREATE TABLE `nodes` (
	`id` text PRIMARY KEY NOT NULL,
	`tree_id` text NOT NULL,
	`parent_node_id` text,
	`author_id` text,
	`inline` integer DEFAULT false NOT NULL,
	`type` text NOT NULL,
	`message_json` text,
	`anchor_json` text,
	`format` text,
	`source` text,
	`model` text,
	`effort` text,
	`title` text,
	`response_preview` text,
	`status` text,
	`error` text,
	`attempt` integer DEFAULT 1 NOT NULL,
	`run_seq` integer DEFAULT 0 NOT NULL,
	`resume_pending` integer DEFAULT false NOT NULL,
	`response_snapshot_at` integer,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`completed_at` integer,
	`edited_at` integer,
	`edited_by` text,
	`chain_order_json` text,
	`recap_json` text,
	FOREIGN KEY (`tree_id`) REFERENCES `trees`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`edited_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "nodes_status_ck" CHECK(("nodes"."type" = 'exchange') = ("nodes"."status" IS NOT NULL)),
	CONSTRAINT "nodes_format_ck" CHECK(("nodes"."type" = 'post') = ("nodes"."format" IS NOT NULL)),
	CONSTRAINT "nodes_source_ck" CHECK(("nodes"."type" = 'document') = ("nodes"."source" IS NOT NULL)),
	CONSTRAINT "nodes_message_ck" CHECK("nodes"."type" = 'document' OR "nodes"."message_json" IS NOT NULL),
	CONSTRAINT "nodes_model_ck" CHECK("nodes"."type" <> 'exchange' OR "nodes"."model" IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX `nodes_tree_idx` ON `nodes` (`tree_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `nodes_status_idx` ON `nodes` (`status`);--> statement-breakpoint
CREATE INDEX `nodes_parent_idx` ON `nodes` (`parent_node_id`);--> statement-breakpoint
CREATE INDEX `nodes_author_idx` ON `nodes` (`author_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `nodes_inline_child_uq` ON `nodes` (`parent_node_id`) WHERE "nodes"."inline" = 1;--> statement-breakpoint
CREATE TABLE `user_preferences` (
	`user_id` text PRIMARY KEY NOT NULL,
	`settings_json` text NOT NULL,
	`research_launch_instruction` text,
	`default_workspace_id` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `node_messages` (
	`node_id` text NOT NULL,
	`position` integer NOT NULL,
	`message_json` text NOT NULL,
	`model` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`node_id`, `position`),
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `node_summaries` (
	`node_id` text PRIMARY KEY NOT NULL,
	`summary` text NOT NULL,
	`covers_through_node_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `run_attempts` (
	`node_id` text NOT NULL,
	`attempt` integer NOT NULL,
	`kind` text NOT NULL,
	`model` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`outcome` text,
	`error_class` text,
	`steps` integer DEFAULT 0 NOT NULL,
	`tool_calls` integer DEFAULT 0 NOT NULL,
	`usage_json` text,
	`cost_estimate_micros` integer,
	PRIMARY KEY(`node_id`, `attempt`),
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `run_queue` (
	`node_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`pool` text NOT NULL,
	`provider` text NOT NULL,
	`enqueued_at` integer NOT NULL,
	`claimed_at` integer,
	`not_before` integer,
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `run_queue_claim_idx` ON `run_queue` (`pool`,`claimed_at`,`enqueued_at`);--> statement-breakpoint
CREATE TABLE `run_turns` (
	`node_id` text NOT NULL,
	`attempt` integer NOT NULL,
	`turn_id` text NOT NULL,
	`position` integer NOT NULL,
	`turn_json` text NOT NULL,
	`committed` integer NOT NULL,
	`seq` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`node_id`, `attempt`, `turn_id`),
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `run_turns_order_idx` ON `run_turns` (`node_id`,`attempt`,`position`);--> statement-breakpoint
CREATE TABLE `oauth_states` (
	`state` text PRIMARY KEY NOT NULL,
	`code_verifier` text NOT NULL,
	`created_at` integer NOT NULL,
	`return_to` text
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`user_agent` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`,`last_seen_at`);--> statement-breakpoint
CREATE TABLE `response_snapshots` (
	`node_id` text PRIMARY KEY NOT NULL,
	`revision` text NOT NULL,
	`turns_json` text NOT NULL,
	`outcome_json` text,
	`byte_size` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `tree_views` (
	`user_id` text NOT NULL,
	`tree_id` text NOT NULL,
	`last_viewed_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `tree_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tree_id`) REFERENCES `trees`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `tree_views_tree_idx` ON `tree_views` (`tree_id`);--> statement-breakpoint
CREATE TABLE `trees` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`title` text NOT NULL,
	`root_node_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer,
	`trashed_at` integer,
	`trashed_by` text,
	`parent_tree_id` text,
	`visibility` text DEFAULT 'private' NOT NULL,
	`position` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`trashed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`parent_tree_id`) REFERENCES `trees`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `trees_sidebar_idx` ON `trees` (`owner_id`,`workspace_id`,`archived_at`,`trashed_at`,`position`);--> statement-breakpoint
CREATE INDEX `trees_trash_idx` ON `trees` (`owner_id`,`trashed_at`);--> statement-breakpoint
CREATE INDEX `trees_parent_idx` ON `trees` (`parent_tree_id`);--> statement-breakpoint
CREATE INDEX `trees_visibility_idx` ON `trees` (`visibility`,`updated_at`);--> statement-breakpoint
CREATE TABLE `tweet_cache` (
	`tweet_id` text PRIMARY KEY NOT NULL,
	`payload_json` text,
	`snapshot_json` text,
	`fetched_at` integer NOT NULL,
	`status` text NOT NULL,
	`provider` text,
	`failure` text
);
--> statement-breakpoint
CREATE TABLE `usage_events` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`node_id` text,
	`kind` text NOT NULL,
	`provider` text NOT NULL,
	`model` text,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`reasoning_tokens` integer DEFAULT 0 NOT NULL,
	`cached_tokens` integer DEFAULT 0 NOT NULL,
	`cost_estimate_micros` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `usage_events_user_idx` ON `usage_events` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `invites` (
	`code` text PRIMARY KEY NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`used_by` text,
	`used_at` integer,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`used_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `signup_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`ip_hash` text NOT NULL,
	`attempted_at` integer NOT NULL,
	`outcome` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `signup_attempts_ip_idx` ON `signup_attempts` (`ip_hash`,`attempted_at`);--> statement-breakpoint
CREATE TABLE `user_limits` (
	`user_id` text PRIMARY KEY NOT NULL,
	`daily_tokens` integer,
	`daily_runs` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`github_id` integer NOT NULL,
	`login` text NOT NULL,
	`name` text,
	`avatar_url` text,
	`is_admin` integer DEFAULT false NOT NULL,
	`github_created_at` integer,
	`signup_ip_hash` text,
	`invited_by` text,
	`invites_remaining` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`last_login_at` integer NOT NULL,
	FOREIGN KEY (`invited_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_github_id_unique` ON `users` (`github_id`);--> statement-breakpoint
CREATE INDEX `users_login_idx` ON `users` (`login`);--> statement-breakpoint
CREATE TABLE `widget_revisions` (
	`tree_id` text NOT NULL,
	`artifact_id` text NOT NULL,
	`revision` text NOT NULL,
	`node_id` text NOT NULL,
	`slot` text NOT NULL,
	`title` text NOT NULL,
	`content_hash` text NOT NULL,
	`parent_revision` text,
	`html` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`tree_id`, `artifact_id`, `revision`),
	FOREIGN KEY (`tree_id`) REFERENCES `trees`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `widget_state` (
	`tree_id` text NOT NULL,
	`artifact_id` text NOT NULL,
	`revision` text NOT NULL,
	`user_id` text NOT NULL,
	`state_json` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`tree_id`, `artifact_id`, `revision`, `user_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tree_id`,`artifact_id`,`revision`) REFERENCES `widget_revisions`(`tree_id`,`artifact_id`,`revision`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`position` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `workspaces_user_idx` ON `workspaces` (`user_id`,`position`);