-- Accounts (plan `04` I1, `01` C8, D5): sign-in identity by provider,
-- account status, handles, and account invites stored hashed.
--
-- Written by hand: the schema no longer declares the research tables that
-- 0000 still creates, so a generated migration would drop them (`01` D5
-- squashes the history in M8a). Columns are changed in place rather than by
-- rebuilding `users`, because the migrator runs inside one transaction where
-- `PRAGMA foreign_keys = OFF` has no effect, and dropping `users` would
-- cascade into every table that references it.
--
-- The old `invites` table keyed rows on the plain code. It is renamed to
-- `invites_legacy`; the backfill `0002-hash-account-invites`
-- (`src/backfills/index.ts`) moves its rows into the new table with the
-- code's hash and drops it, since SQLite has no SHA-256 for SQL to use.
ALTER TABLE `invites` RENAME TO `invites_legacy`;
--> statement-breakpoint
CREATE TABLE `invites` (
	`id` text PRIMARY KEY NOT NULL,
	`code_hash` text NOT NULL,
	`code_enc` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`used_by` text,
	`used_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`used_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invites_code_hash_unique` ON `invites` (`code_hash`);
--> statement-breakpoint
CREATE INDEX `invites_created_by_idx` ON `invites` (`created_by`,`created_at`);
--> statement-breakpoint
ALTER TABLE `users` ADD `provider` text CHECK ("provider" IN ('github', 'x'));
--> statement-breakpoint
ALTER TABLE `users` ADD `provider_user_id` text;
--> statement-breakpoint
UPDATE `users` SET `provider` = 'github', `provider_user_id` = CAST(`github_id` AS text);
--> statement-breakpoint
DROP INDEX `users_github_id_unique`;
--> statement-breakpoint
ALTER TABLE `users` DROP COLUMN `github_id`;
--> statement-breakpoint
ALTER TABLE `users` RENAME COLUMN `github_created_at` TO `provider_created_at`;
--> statement-breakpoint
ALTER TABLE `users` DROP COLUMN `invites_remaining`;
--> statement-breakpoint
ALTER TABLE `users` ADD `email` text;
--> statement-breakpoint
ALTER TABLE `users` ADD `status` text DEFAULT 'waiting' NOT NULL CHECK ("status" IN ('waiting', 'active'));
--> statement-breakpoint
ALTER TABLE `users` ADD `handle` text;
--> statement-breakpoint
ALTER TABLE `users` ADD `display_name` text;
--> statement-breakpoint
ALTER TABLE `users` ADD `pending_invite_id` text REFERENCES `invites`(`id`) ON UPDATE no action ON DELETE set null;
--> statement-breakpoint
ALTER TABLE `users` ADD `activated_at` integer;
--> statement-breakpoint
ALTER TABLE `users` ADD `deleted_at` integer;
--> statement-breakpoint
CREATE UNIQUE INDEX `users_identity_unique` ON `users` (`provider`,`provider_user_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_handle_unique` ON `users` (`handle`);
--> statement-breakpoint
CREATE INDEX `users_status_idx` ON `users` (`status`,`created_at`);
--> statement-breakpoint
CREATE INDEX `users_invited_by_idx` ON `users` (`invited_by`);
--> statement-breakpoint
ALTER TABLE `oauth_states` ADD `provider` text;
--> statement-breakpoint
ALTER TABLE `oauth_states` ADD `code_hash` text;
