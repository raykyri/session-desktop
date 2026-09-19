CREATE TABLE `feed_items` (
	`id` text PRIMARY KEY NOT NULL,
	`author_id` text NOT NULL,
	`kind` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`source_rank` integer NOT NULL,
	`journal_id` text,
	`node_id` text,
	`tree_id` text,
	`workspace_id` text,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`journal_id`) REFERENCES `journal_entries`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tree_id`) REFERENCES `trees`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `feed_items_order_idx` ON `feed_items` ("occurred_at" desc,"source_rank" desc,"id" desc);--> statement-breakpoint
CREATE INDEX `feed_items_author_idx` ON `feed_items` (`author_id`,"occurred_at" desc);--> statement-breakpoint
CREATE UNIQUE INDEX `feed_items_journal_uq` ON `feed_items` (`journal_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `feed_items_node_uq` ON `feed_items` (`node_id`);