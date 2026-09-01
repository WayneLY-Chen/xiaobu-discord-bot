import { eq, sql } from 'drizzle-orm';
import type { Db } from '../client.js';
import {
  guildSettings,
  userSettings,
  type GuildSettingsRow,
  type UserSettingsRow,
} from '../schema.js';

export function getGuildSettings(db: Db, guildId: string): GuildSettingsRow | undefined {
  return db.select().from(guildSettings).where(eq(guildSettings.guildId, guildId)).get();
}

/** 第一次讀取時建立預設列，之後直接回傳。 */
export function ensureGuildSettings(db: Db, guildId: string): GuildSettingsRow {
  const existing = getGuildSettings(db, guildId);
  if (existing) return existing;

  db.insert(guildSettings).values({ guildId }).onConflictDoNothing().run();
  const created = getGuildSettings(db, guildId);
  if (!created) throw new Error(`無法建立 guild_settings：${guildId}`);
  return created;
}

type GuildSettingsPatch = Partial<Omit<GuildSettingsRow, 'guildId' | 'updatedAt'>>;

export function updateGuildSettings(db: Db, guildId: string, patch: GuildSettingsPatch): void {
  ensureGuildSettings(db, guildId);
  db.update(guildSettings)
    .set({ ...patch, updatedAt: sql`(unixepoch())` })
    .where(eq(guildSettings.guildId, guildId))
    .run();
}

/** 重設為系統預設值（清空所有覆寫）。 */
export function resetGuildSettings(db: Db, guildId: string): void {
  db.delete(guildSettings).where(eq(guildSettings.guildId, guildId)).run();
  ensureGuildSettings(db, guildId);
}

export function getUserSettings(db: Db, userId: string): UserSettingsRow | undefined {
  return db.select().from(userSettings).where(eq(userSettings.userId, userId)).get();
}

export function ensureUserSettings(db: Db, userId: string): UserSettingsRow {
  const existing = getUserSettings(db, userId);
  if (existing) return existing;

  db.insert(userSettings).values({ userId }).onConflictDoNothing().run();
  const created = getUserSettings(db, userId);
  if (!created) throw new Error(`無法建立 user_settings：${userId}`);
  return created;
}

type UserSettingsPatch = Partial<Omit<UserSettingsRow, 'userId' | 'updatedAt'>>;

export function updateUserSettings(db: Db, userId: string, patch: UserSettingsPatch): void {
  ensureUserSettings(db, userId);
  db.update(userSettings)
    .set({ ...patch, updatedAt: sql`(unixepoch())` })
    .where(eq(userSettings.userId, userId))
    .run();
}

export function resetUserSettings(db: Db, userId: string): void {
  db.delete(userSettings).where(eq(userSettings.userId, userId)).run();
  ensureUserSettings(db, userId);
}
