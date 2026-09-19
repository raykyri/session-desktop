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
ALTER TABLE `tweet_cache` ADD `provider` text;