CREATE TABLE `guild_triggers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`guild_id` text NOT NULL,
	`phrase` text NOT NULL,
	`phrase_raw` text NOT NULL,
	`response` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`guild_id`) REFERENCES `guilds`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `guild_triggers_guild_idx` ON `guild_triggers` (`guild_id`,`id`);