import { and, desc, eq, sql } from 'drizzle-orm';
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
