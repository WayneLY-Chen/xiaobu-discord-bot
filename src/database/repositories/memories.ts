import { and, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../client.js';
import { memories, type MemoryRow } from '../schema.js';

/** 一個人在單一伺服器能存的記憶則數上限，避免無限成長把 context 撐爆。 */
export const MAX_MEMORIES_PER_USER = 50;
export const MAX_MEMORY_LENGTH = 300;

/**
 * 長期記憶的範圍是 (guild_id, user_id)：每個人在每個伺服器一份，跨伺服器不互通。
 *
 * 這是規格 §17 的硬性要求 —— 同一個人在 A 伺服器說的話，
 * 在 B 伺服器不該被讀到。所有查詢都必須同時帶這兩個條件。
 */
export function listMemories(db: Db, guildId: string, userId: string): MemoryRow[] {
  return db
    .select()
    .from(memories)
    .where(and(eq(memories.guildId, guildId), eq(memories.userId, userId)))
    .orderBy(desc(memories.id))
    .all();
}

export interface AddMemoryOutcome {
  status: 'added' | 'duplicate' | 'full';
  total: number;
}

export function addMemory(
  db: Db,
  guildId: string,
  userId: string,
  content: string,
): AddMemoryOutcome {
  const trimmed = content.trim().slice(0, MAX_MEMORY_LENGTH);
  const existing = listMemories(db, guildId, userId);

  // 使用者常常會重複說同一件事，重複存只是浪費 context
  if (existing.some((row) => row.content === trimmed)) {
    return { status: 'duplicate', total: existing.length };
  }

  if (existing.length >= MAX_MEMORIES_PER_USER) {
    return { status: 'full', total: existing.length };
  }

  db.insert(memories).values({ guildId, userId, content: trimmed }).run();

  return { status: 'added', total: existing.length + 1 };
}

/** 回傳是否真的刪到 —— 刪不存在的 id 要能回報，不能默默成功。 */
export function deleteMemory(db: Db, guildId: string, userId: string, id: number): boolean {
  const result = db
    .delete(memories)
    .where(and(eq(memories.id, id), eq(memories.guildId, guildId), eq(memories.userId, userId)))
    .run();

  return result.changes > 0;
}

export function clearMemories(db: Db, guildId: string, userId: string): number {
  const result = db
    .delete(memories)
    .where(and(eq(memories.guildId, guildId), eq(memories.userId, userId)))
    .run();

  return result.changes;
}

export function updateMemory(
  db: Db,
  guildId: string,
  userId: string,
  id: number,
  content: string,
): boolean {
  const result = db
    .update(memories)
    .set({ content: content.trim().slice(0, MAX_MEMORY_LENGTH), updatedAt: sql`(unixepoch())` })
    .where(and(eq(memories.id, id), eq(memories.guildId, guildId), eq(memories.userId, userId)))
    .run();

  return result.changes > 0;
}
