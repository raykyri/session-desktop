ALTER TABLE `tree_members` ADD `archived_at` integer;--> statement-breakpoint
ALTER TABLE `tree_members` ADD `trashed_at` integer;--> statement-breakpoint
ALTER TABLE `tree_members` ADD `folder_id` text REFERENCES folders(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `trees` ADD `trashed_by` text REFERENCES users(id) ON DELETE SET NULL;