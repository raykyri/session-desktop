CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`raw_enc` text NOT NULL,
	`fingerprint` text NOT NULL,
	`mask` text NOT NULL,
	`provider` text NOT NULL,
	`reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_used_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_fingerprint_idx` ON `api_keys` (`user_id`,`fingerprint`);--> statement-breakpoint
CREATE INDEX `api_keys_user_idx` ON `api_keys` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `backfills` (
	`id` text PRIMARY KEY NOT NULL,
	`applied_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `user_preferences` (
	`user_id` text PRIMARY KEY NOT NULL,
	`settings_json` text NOT NULL,
	`research_launch_instruction` text,
	`account_json` text NOT NULL,
	`default_key_id` text,
	`moved_seen` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `run_attempts` (
	`run_id` text NOT NULL,
	`n` integer NOT NULL,
	`kind` text NOT NULL,
	`model` text NOT NULL,
	`payer` text,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`outcome` text,
	`error_class` text,
	`steps` integer DEFAULT 0 NOT NULL,
	`tool_calls` integer DEFAULT 0 NOT NULL,
	`usage_json` text,
	`cost_estimate_micros` integer,
	PRIMARY KEY(`run_id`, `n`)
);
--> statement-breakpoint
CREATE TABLE `run_queue` (
	`run_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`enqueued_at` integer NOT NULL,
	`claimed_at` integer,
	`not_before` integer,
	`resumes` integer DEFAULT 0 NOT NULL,
	`seq` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `run_queue_claim_idx` ON `run_queue` (`claimed_at`,`enqueued_at`);--> statement-breakpoint
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
CREATE TABLE `usage_events` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`run_id` text,
	`space_id` text,
	`payer` text,
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
CREATE INDEX `usage_events_payer_idx` ON `usage_events` (`user_id`,`payer`,`created_at`);--> statement-breakpoint
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
	`handle` text NOT NULL,
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
CREATE UNIQUE INDEX `users_handle_unique` ON `users` (`handle`);--> statement-breakpoint
CREATE INDEX `users_login_idx` ON `users` (`login`);