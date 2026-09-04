import { and, desc, eq, lt, notInArray, sql } from 'drizzle-orm';
import type { Db } from '../client.js';
import { conversations, messages, type MessageRow } from '../schema.js';

/**
 * 短期對話的範圍是 (guild_id, channel_id)：同一個頻道的所有人共用一條上下文，
 * 符合 Discord 群聊習慣（Planning §17.5）。
 */
export function getOrCreateConversation(db: Db, guildId: string, channelId: string): number {
  const existing = db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.guildId, guildId), eq(conversations.channelId, channelId)))
    .get();

  if (existing) return existing.id;

  const created = db
    .insert(conversations)
    .values({ guildId, channelId })
    .returning({ id: conversations.id })
    .get();

  return created.id;
}

export function touchConversation(db: Db, conversationId: number): void {
  db.update(conversations)
    .set({ lastActiveAt: sql`(unixepoch())` })
    .where(eq(conversations.id, conversationId))
    .run();
}

export function appendUserMessage(
  db: Db,
  conversationId: number,
  userId: string,
  username: string,
  content: string,
): void {
  db.insert(messages)
    .values({ conversationId, role: 'user', userId, username, content })
    .run();
}

export function appendAssistantMessage(db: Db, conversationId: number, content: string): void {
  db.insert(messages).values({ conversationId, role: 'assistant', content }).run();
}

/** 取最近 N 則，回傳時轉回時間正序方便組 prompt。 */
export function getRecentMessages(db: Db, conversationId: number, limit: number): MessageRow[] {
  const rows = db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.id))
    .limit(limit)
    .all();

  return rows.reverse();
}

/** 清空某個頻道的對話。回傳刪掉的訊息數。 */
export function clearConversation(db: Db, guildId: string, channelId: string): number {
  const conversation = db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.guildId, guildId), eq(conversations.channelId, channelId)))
    .get();

  if (!conversation) return 0;

  const result = db.delete(messages).where(eq(messages.conversationId, conversation.id)).run();
  return result.changes;
}

/**
 * 刪掉超過保留期的訊息，以及跟著空掉的對話串。
 *
 * 在這之前 messages 這張表只增不減 —— 只有 /reset 會刪，而那要有人主動去按。
 * 一個公開 Bot 累積下來的是「所有伺服器所有頻道的全部對話，永久保存」，
 * 那既是磁碟問題也是隱私問題。
 *
 * 回傳刪掉的訊息筆數。retentionMs 為 0 或負數代表不清理。
 */
export function pruneOldMessages(db: Db, retentionMs: number, now: number = Date.now()): number {
  if (retentionMs <= 0) return 0;

  // created_at 存的是 unixepoch **秒**，不是毫秒也不是 Date
  const cutoffSeconds = Math.floor((now - retentionMs) / 1000);
  const removed = db.delete(messages).where(lt(messages.createdAt, cutoffSeconds)).run().changes;

  // 訊息刪光的對話串留著沒有意義，順手收掉（外鍵是 cascade，順序不能反）
  db.delete(conversations)
    .where(
      notInArray(
        conversations.id,
        db.selectDistinct({ id: messages.conversationId }).from(messages),
      ),
    )
    .run();

  return removed;
}
