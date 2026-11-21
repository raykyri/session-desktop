-- Members' provider keys, their billing setting, and the site-wide settings
-- (03-agents-and-research.md K4, K7, K15; ADR-23). Written by hand: the
-- drizzle-kit snapshot still holds the research tables the schema no longer
-- declares, so `drizzle-kit generate` cannot diff against it until M8a
-- squashes the history (01 D5).
CREATE TABLE `api_keys` (
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`sealed` text NOT NULL,
	`last4` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `provider`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `usage_billing` (
	`user_id` text PRIMARY KEY NOT NULL,
	`mode` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `site_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value_json` text NOT NULL,
	`updated_by` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
