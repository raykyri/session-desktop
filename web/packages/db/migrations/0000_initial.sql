CREATE TABLE `artifact_tokens` (
	`token` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`document_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `artifact_tokens_document_idx` ON `artifact_tokens` (`document_id`);--> statement-breakpoint
CREATE TABLE `backfills` (
	`id` text PRIMARY KEY NOT NULL,
	`applied_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `document_text` (
	`document_id` text NOT NULL,
	`page` integer NOT NULL,
	`text` text NOT NULL,
	PRIMARY KEY(`document_id`, `page`),
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `documents` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`mime` text NOT NULL,
	`byte_size` integer NOT NULL,
	`sha256` text NOT NULL,
	`storage_path` text NOT NULL,
	`page_count` integer,
	`extraction_status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `documents_user_sha_uq` ON `documents` (`user_id`,`sha256`);--> statement-breakpoint
CREATE TABLE `node_documents` (
	`node_id` text NOT NULL,
	`document_id` text NOT NULL,
	`position` integer NOT NULL,
	PRIMARY KEY(`node_id`, `document_id`),
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `interface_drafts` (
	`user_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `key`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `encyclopedia_pages` (
	`user_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`slug` text NOT NULL,
	`term` text NOT NULL,
	`title` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`model` text NOT NULL,
	`generated_by` text,
	`links_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`workspace_id`, `slug`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `encyclopedia_pages_title_idx` ON `encyclopedia_pages` (`workspace_id`,`title`);--> statement-breakpoint
CREATE TABLE `encyclopedia_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`slug` text NOT NULL,
	`node_id` text,
	`tree_id` text,
	`page_slug` text,
	`question` text,
	`excerpt` text NOT NULL,
	`sibling_terms_json` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`,`slug`) REFERENCES `encyclopedia_pages`(`workspace_id`,`slug`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `encyclopedia_sources_page_idx` ON `encyclopedia_sources` (`workspace_id`,`slug`,`created_at`);--> statement-breakpoint
CREATE TABLE `folders` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`collapsed` integer DEFAULT false NOT NULL,
	`starred` integer DEFAULT 0 NOT NULL,
	`position` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `folders_workspace_idx` ON `folders` (`user_id`,`workspace_id`,`position`);--> statement-breakpoint
CREATE TABLE `tree_folder_membership` (
	`tree_id` text PRIMARY KEY NOT NULL,
	`folder_id` text NOT NULL,
	FOREIGN KEY (`tree_id`) REFERENCES `trees`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`folder_id`) REFERENCES `folders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `highlights` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`node_id` text NOT NULL,
	`anchor_json` text NOT NULL,
	`response_revision` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `highlights_node_idx` ON `highlights` (`node_id`);--> statement-breakpoint
CREATE INDEX `highlights_user_idx` ON `highlights` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `journal_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`created_at` integer NOT NULL,
	`url` text,
	`tweet_id` text,
	`hydration` text,
	`text` text,
	`entry_json` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `journal_entries_user_idx` ON `journal_entries` (`user_id`,`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `nodes` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`tree_id` text NOT NULL,
	`parent_node_id` text,
	`inline` integer DEFAULT false NOT NULL,
	`prompt` text NOT NULL,
	`query_anchor_json` text,
	`attachments_json` text DEFAULT '[]' NOT NULL,
	`title` text,
	`response_preview` text,
	`model` text NOT NULL,
	`kind` text DEFAULT 'run' NOT NULL,
	`origin` text,
	`status` text NOT NULL,
	`error` text,
	`attempt` integer DEFAULT 1 NOT NULL,
	`run_seq` integer DEFAULT 0 NOT NULL,
	`resume_pending` integer DEFAULT false NOT NULL,
	`response_snapshot_at` integer,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`completed_at` integer,
	`recap_json` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tree_id`) REFERENCES `trees`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `nodes_tree_idx` ON `nodes` (`tree_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `nodes_status_idx` ON `nodes` (`user_id`,`status`);--> statement-breakpoint
CREATE INDEX `nodes_parent_idx` ON `nodes` (`parent_node_id`);--> statement-breakpoint
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
CREATE TABLE `trees` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`title` text NOT NULL,
	`root_node_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer,
	`last_viewed_at` integer,
	`followed` integer DEFAULT false NOT NULL,
	`bookmarked` integer DEFAULT false NOT NULL,
	`starred` integer DEFAULT 0 NOT NULL,
	`position` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `trees_sidebar_idx` ON `trees` (`user_id`,`workspace_id`,`archived_at`,`position`);--> statement-breakpoint
CREATE INDEX `trees_updated_idx` ON `trees` (`user_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `tweet_cache` (
	`tweet_id` text PRIMARY KEY NOT NULL,
	`payload_json` text,
	`snapshot_json` text,
	`fetched_at` integer NOT NULL,
	`status` text NOT NULL,
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