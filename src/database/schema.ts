import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

/** SQLite 沒有原生時間型別，統一用 unix epoch 秒數存。 */
const timestamp = (name: string) =>
  integer(name)
    .notNull()
    .default(sql`(unixepoch())`);

const bool = (name: string, defaultValue: boolean) =>
  integer(name, { mode: 'boolean' }).notNull().default(defaultValue);

// ---------------------------------------------------------------------------
// 身分
// ---------------------------------------------------------------------------

export const users = sqliteTable('users', {
  /** Discord user id（snowflake）。跨 guild 相同。 */
  id: text('id').primaryKey(),
  username: text('username').notNull(),
  createdAt: timestamp('created_at'),
  updatedAt: timestamp('updated_at'),
});

export const guilds = sqliteTable('guilds', {
  /** Discord guild id（snowflake）。 */
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  joinedAt: timestamp('joined_at'),
  /** Bot 被踢出時設為 false，保留歷史資料而非直接刪除。 */
  active: bool('active', true),
});

// ---------------------------------------------------------------------------
// 設定
// ---------------------------------------------------------------------------

/** 每個 guild 一列。null 代表「沿用系統預設」。 */
export const guildSettings = sqliteTable('guild_settings', {
  guildId: text('guild_id')
    .primaryKey()
    .references(() => guilds.id, { onDelete: 'cascade' }),
  /** 指定 AI 頻道；null = 只有 @Bot 才回應。 */
  aiChannelId: text('ai_channel_id'),
  model: text('model'),
  systemPrompt: text('system_prompt'),
  locale: text('locale'),
  chatEnabled: bool('chat_enabled', true),
  memoryEnabled: bool('memory_enabled', true),
  // 以下為後續 Phase 的開關，先建欄位但 Phase 1 尚未實作對應功能
  imageEnabled: bool('image_enabled', false),
  musicEnabled: bool('music_enabled', false),
  voiceEnabled: bool('voice_enabled', false),
  updatedAt: timestamp('updated_at'),
});

/** 每個 user 一列，跨 guild 共用（這是使用者本人的偏好，不是 guild 資料）。 */
export const userSettings = sqliteTable('user_settings', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  model: text('model'),
  locale: text('locale'),
  personality: text('personality'),
  memoryEnabled: bool('memory_enabled', true),
  updatedAt: timestamp('updated_at'),
});

// ---------------------------------------------------------------------------
// 短期對話：範圍 = (guild_id, channel_id)，同頻道所有人共用（Planning §17.5）
// ---------------------------------------------------------------------------

export const conversations = sqliteTable(
  'conversations',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    guildId: text('guild_id').notNull(),
    channelId: text('channel_id').notNull(),
    createdAt: timestamp('created_at'),
    lastActiveAt: timestamp('last_active_at'),
  },
  (table) => [
    uniqueIndex('conversations_guild_channel_unique').on(
      table.guildId,
      table.channelId,
    ),
  ],
);

export const messages = sqliteTable(
  'messages',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    conversationId: integer('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['user', 'assistant'] }).notNull(),
    /** assistant 訊息為 null。 */
    userId: text('user_id'),
    /** 發話當下的 displayName 快照，用來在 prompt 標記說話者。 */
    username: text('username'),
    content: text('content').notNull(),
    createdAt: timestamp('created_at'),
  },
  (table) => [
    index('messages_conversation_idx').on(table.conversationId, table.id),
  ],
);

// ---------------------------------------------------------------------------
// 長期記憶：範圍 = (guild_id, user_id)，每人一份，跨 guild 不互通（Planning §17）
// Phase 1 只建表，/memory 指令在 Phase 3 實作。
// ---------------------------------------------------------------------------

export const memories = sqliteTable(
  'memories',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    guildId: text('guild_id').notNull(),
    userId: text('user_id').notNull(),
    content: text('content').notNull(),
    createdAt: timestamp('created_at'),
    updatedAt: timestamp('updated_at'),
  },
  (table) => [index('memories_guild_user_idx').on(table.guildId, table.userId)],
);

// ---------------------------------------------------------------------------
// 音樂佇列：Phase 5 使用，Phase 1 只建表
// ---------------------------------------------------------------------------

export const musicQueues = sqliteTable(
  'music_queues',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    guildId: text('guild_id').notNull(),
    voiceChannelId: text('voice_channel_id').notNull(),
    position: integer('position').notNull(),
    title: text('title').notNull(),
    url: text('url').notNull(),
    durationSeconds: integer('duration_seconds'),
    requestedBy: text('requested_by').notNull(),
    createdAt: timestamp('created_at'),
  },
  (table) => [index('music_queues_guild_idx').on(table.guildId, table.position)],
);

// ---------------------------------------------------------------------------
// 用量統計
// ---------------------------------------------------------------------------

export const usage = sqliteTable(
  'usage',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    guildId: text('guild_id').notNull(),
    userId: text('user_id').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    /** chat / image / search / voice，Phase 1 只有 chat。 */
    kind: text('kind').notNull(),
    requests: integer('requests').notNull().default(1),
    tokensIn: integer('tokens_in').notNull().default(0),
    tokensOut: integer('tokens_out').notNull().default(0),
    images: integer('images').notNull().default(0),
    searches: integer('searches').notNull().default(0),
    voiceSeconds: integer('voice_seconds').notNull().default(0),
    createdAt: timestamp('created_at'),
  },
  (table) => [index('usage_guild_created_idx').on(table.guildId, table.createdAt)],
);

export type GuildSettingsRow = typeof guildSettings.$inferSelect;
export type UserSettingsRow = typeof userSettings.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type MemoryRow = typeof memories.$inferSelect;
