import { sql } from 'drizzle-orm';
import type { Db } from '../client.js';
import { guilds, users } from '../schema.js';

/**
 * 確保 user 存在（Discord 是唯一真實來源，這裡只做本地快取）。
 * username 每次都更新，因為使用者會改名。
 */
export function upsertUser(db: Db, id: string, username: string): void {
  db.insert(users)
    .values({ id, username })
    .onConflictDoUpdate({
      target: users.id,
      set: { username, updatedAt: sql`(unixepoch())` },
    })
    .run();
}

export function upsertGuild(db: Db, id: string, name: string): void {
  db.insert(guilds)
    .values({ id, name, active: true })
    .onConflictDoUpdate({
      target: guilds.id,
      set: { name, active: true },
    })
    .run();
}

/** Bot 被踢出時呼叫。不刪資料，避免使用者重新邀請後設定全失。 */
export function markGuildInactive(db: Db, id: string): void {
  db.update(guilds).set({ active: false }).where(sql`${guilds.id} = ${id}`).run();
}
