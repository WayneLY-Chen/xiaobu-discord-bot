CREATE TABLE `conversations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`guild_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`last_active_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversations_guild_channel_unique` ON `conversations` (`guild_id`,`channel_id`);--> statement-breakpoint
CREATE TABLE `guild_settings` (
	`guild_id` text PRIMARY KEY NOT NULL,
	`ai_channel_id` text,
	`model` text,
	`system_prompt` text,
	`locale` text,
	`chat_enabled` integer DEFAULT true NOT NULL,
	`memory_enabled` integer DEFAULT true NOT NULL,
	`image_enabled` integer DEFAULT false NOT NULL,
	`music_enabled` integer DEFAULT false NOT NULL,
	`voice_enabled` integer DEFAULT false NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`guild_id`) REFERENCES `guilds`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `guilds` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`joined_at` integer DEFAULT (unixepoch()) NOT NULL,
	`active` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE `memories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`guild_id` text NOT NULL,
	`user_id` text NOT NULL,
	`content` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `memories_guild_user_idx` ON `memories` (`guild_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`conversation_id` integer NOT NULL,
	`role` text NOT NULL,
	`user_id` text,
	`username` text,
	`content` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `messages_conversation_idx` ON `messages` (`conversation_id`,`id`);--> statement-breakpoint
CREATE TABLE `music_queues` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`guild_id` text NOT NULL,
	`voice_channel_id` text NOT NULL,
	`position` integer NOT NULL,
	`title` text NOT NULL,
	`url` text NOT NULL,
	`duration_seconds` integer,
	`requested_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `music_queues_guild_idx` ON `music_queues` (`guild_id`,`position`);--> statement-breakpoint
CREATE TABLE `usage` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`guild_id` text NOT NULL,
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`kind` text NOT NULL,
	`requests` integer DEFAULT 1 NOT NULL,
	`tokens_in` integer DEFAULT 0 NOT NULL,
	`tokens_out` integer DEFAULT 0 NOT NULL,
	`images` integer DEFAULT 0 NOT NULL,
	`searches` integer DEFAULT 0 NOT NULL,
	`voice_seconds` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `usage_guild_created_idx` ON `usage` (`guild_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `user_settings` (
	`user_id` text PRIMARY KEY NOT NULL,
	`model` text,
	`locale` text,
	`personality` text,
	`memory_enabled` integer DEFAULT true NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
