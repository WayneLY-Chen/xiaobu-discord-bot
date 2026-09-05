PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_guild_settings` (
	`guild_id` text PRIMARY KEY NOT NULL,
	`ai_channel_id` text,
	`model` text,
	`system_prompt` text,
	`locale` text,
	`chat_enabled` integer DEFAULT true NOT NULL,
	`memory_enabled` integer DEFAULT true NOT NULL,
	`image_enabled` integer DEFAULT false NOT NULL,
	`music_enabled` integer DEFAULT false NOT NULL,
	`voice_enabled` integer DEFAULT true NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`guild_id`) REFERENCES `guilds`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_guild_settings`("guild_id", "ai_channel_id", "model", "system_prompt", "locale", "chat_enabled", "memory_enabled", "image_enabled", "music_enabled", "voice_enabled", "updated_at") SELECT "guild_id", "ai_channel_id", "model", "system_prompt", "locale", "chat_enabled", "memory_enabled", "image_enabled", "music_enabled", "voice_enabled", "updated_at" FROM `guild_settings`;--> statement-breakpoint
DROP TABLE `guild_settings`;--> statement-breakpoint
ALTER TABLE `__new_guild_settings` RENAME TO `guild_settings`;--> statement-breakpoint
-- 舊資料一律補成開啟：這個開關在本次 migration 之前不存在，
-- 所有存著的 0 都是「從沒設定過」，不是管理員關掉的。
UPDATE `guild_settings` SET `voice_enabled` = 1;--> statement-breakpoint
PRAGMA foreign_keys=ON;