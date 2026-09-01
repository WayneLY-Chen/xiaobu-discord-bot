import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, type Db } from '../src/database/client.js';
import { memories } from '../src/database/schema.js';
import { upsertGuild, upsertUser } from '../src/database/repositories/identity.js';
import {
  ensureGuildSettings,
  getGuildSettings,
  updateGuildSettings,
  updateUserSettings,
  ensureUserSettings,
} from '../src/database/repositories/settings.js';
import {
  appendAssistantMessage,
  appendUserMessage,
  clearConversation,
  getOrCreateConversation,
  getRecentMessages,
} from '../src/database/repositories/conversations.js';
import { getGuildUsage, recordUsage } from '../src/database/repositories/usage.js';
import { resolveSettings } from '../src/config/resolveSettings.js';

const defaults = { model: 'gemini-3.1-flash-lite', locale: 'zh-TW' } as const;

let db: Db;
let close: () => void;

beforeEach(() => {
  const created = createDatabase(':memory:');
  db = created.db;
  close = () => created.connection.close();

  upsertGuild(db, 'serverA', 'Server A');
  upsertGuild(db, 'serverB', 'Server B');
  upsertUser(db, 'user123', 'Wayne');
  upsertUser(db, 'user456', 'Ming');
});

afterEach(() => close());

describe('多伺服器設定隔離（Planning §4）', () => {
  it('兩個伺服器的設定互不影響', () => {
    updateGuildSettings(db, 'serverA', { model: 'gemini-3.7-flash', aiChannelId: 'chanA' });
    updateGuildSettings(db, 'serverB', { model: 'gemini-2.5-flash', aiChannelId: 'chanB' });

    expect(getGuildSettings(db, 'serverA')?.model).toBe('gemini-3.7-flash');
    expect(getGuildSettings(db, 'serverB')?.model).toBe('gemini-2.5-flash');
    expect(getGuildSettings(db, 'serverA')?.aiChannelId).toBe('chanA');
  });

  it('在 A 關閉聊天不會影響 B', () => {
    updateGuildSettings(db, 'serverA', { chatEnabled: false });

    expect(getGuildSettings(db, 'serverA')?.chatEnabled).toBe(false);
    expect(ensureGuildSettings(db, 'serverB').chatEnabled).toBe(true);
  });

  it('同一個使用者在不同伺服器會套用各自的伺服器設定', () => {
    updateGuildSettings(db, 'serverA', { model: 'gemini-3.7-flash' });
    updateGuildSettings(db, 'serverB', { model: 'gemini-2.5-flash' });
    ensureUserSettings(db, 'user123');

    const inA = resolveSettings(
      getGuildSettings(db, 'serverA'),
      ensureUserSettings(db, 'user123'),
      defaults,
    );
    const inB = resolveSettings(
      getGuildSettings(db, 'serverB'),
      ensureUserSettings(db, 'user123'),
      defaults,
    );

    expect(inA.model).toBe('gemini-3.7-flash');
    expect(inB.model).toBe('gemini-2.5-flash');
  });
});

describe('使用者設定隔離（Planning §5）', () => {
  it('一個使用者改設定不影響其他使用者', () => {
    updateUserSettings(db, 'user123', { model: 'gemini-3.7-flash', personality: '簡短' });

    expect(ensureUserSettings(db, 'user123').model).toBe('gemini-3.7-flash');
    expect(ensureUserSettings(db, 'user456').model).toBeNull();
    expect(ensureUserSettings(db, 'user456').personality).toBeNull();
  });
});

describe('對話隔離（Planning §17.5）', () => {
  it('同伺服器不同頻道是不同對話', () => {
    const a = getOrCreateConversation(db, 'serverA', 'chan1');
    const b = getOrCreateConversation(db, 'serverA', 'chan2');

    expect(a).not.toBe(b);
  });

  it('不同伺服器的同名頻道 id 也是不同對話', () => {
    const a = getOrCreateConversation(db, 'serverA', 'chan1');
    const b = getOrCreateConversation(db, 'serverB', 'chan1');

    expect(a).not.toBe(b);
  });

  it('同一個頻道重複取得會拿到同一條對話', () => {
    expect(getOrCreateConversation(db, 'serverA', 'chan1')).toBe(
      getOrCreateConversation(db, 'serverA', 'chan1'),
    );
  });

  it('同頻道多人共用上下文，且每則都記得是誰說的', () => {
    const id = getOrCreateConversation(db, 'serverA', 'chan1');

    appendUserMessage(db, id, 'user123', 'Wayne', '我喜歡 Qwen');
    appendAssistantMessage(db, id, '收到');
    appendUserMessage(db, id, 'user456', 'Ming', '我喜歡什麼？');

    const rows = getRecentMessages(db, id, 10);

    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ userId: 'user123', username: 'Wayne', role: 'user' });
    expect(rows[1]).toMatchObject({ userId: null, role: 'assistant' });
    expect(rows[2]).toMatchObject({ userId: 'user456', username: 'Ming', role: 'user' });
  });

  it('只取最近 N 則，並依時間正序回傳', () => {
    const id = getOrCreateConversation(db, 'serverA', 'chan1');
    for (let i = 0; i < 10; i += 1) {
      appendUserMessage(db, id, 'user123', 'Wayne', `訊息 ${i}`);
    }

    const rows = getRecentMessages(db, id, 3);

    expect(rows.map((row) => row.content)).toEqual(['訊息 7', '訊息 8', '訊息 9']);
  });

  it('清除某頻道的對話不會動到其他頻道', () => {
    const a = getOrCreateConversation(db, 'serverA', 'chan1');
    const b = getOrCreateConversation(db, 'serverB', 'chan1');
    appendUserMessage(db, a, 'user123', 'Wayne', 'A 的訊息');
    appendUserMessage(db, b, 'user123', 'Wayne', 'B 的訊息');

    expect(clearConversation(db, 'serverA', 'chan1')).toBe(1);
    expect(getRecentMessages(db, a, 10)).toHaveLength(0);
    expect(getRecentMessages(db, b, 10)).toHaveLength(1);
  });
});

describe('長期記憶隔離（Planning §17）', () => {
  // Phase 1 只建表，這裡先驗證 schema 的隔離鍵是對的
  it('同一個 user 在不同伺服器是兩份記憶', () => {
    db.insert(memories)
      .values([
        { guildId: 'serverA', userId: 'user123', content: '喜歡 Qwen' },
        { guildId: 'serverB', userId: 'user123', content: '喜歡 Gemini' },
      ])
      .run();

    const inA = db
      .select()
      .from(memories)
      .where(and(eq(memories.guildId, 'serverA'), eq(memories.userId, 'user123')))
      .all();

    expect(inA).toHaveLength(1);
    expect(inA[0]?.content).toBe('喜歡 Qwen');
  });

  it('同伺服器不同使用者的記憶不互通', () => {
    db.insert(memories)
      .values([
        { guildId: 'serverA', userId: 'user123', content: 'Wayne 的祕密' },
        { guildId: 'serverA', userId: 'user456', content: 'Ming 的祕密' },
      ])
      .run();

    const forMing = db
      .select()
      .from(memories)
      .where(and(eq(memories.guildId, 'serverA'), eq(memories.userId, 'user456')))
      .all();

    expect(forMing).toHaveLength(1);
    expect(forMing[0]?.content).toBe('Ming 的祕密');
  });
});

describe('用量統計隔離（Planning §20）', () => {
  it('只統計自己伺服器的用量', () => {
    recordUsage(db, {
      guildId: 'serverA',
      userId: 'user123',
      provider: 'gemini',
      model: 'gemini-3.5-flash',
      kind: 'chat',
      tokensIn: 100,
      tokensOut: 50,
    });
    recordUsage(db, {
      guildId: 'serverB',
      userId: 'user123',
      provider: 'gemini',
      model: 'gemini-3.5-flash',
      kind: 'chat',
      tokensIn: 999,
      tokensOut: 999,
    });

    const summary = getGuildUsage(db, 'serverA', 7);

    expect(summary.requests).toBe(1);
    expect(summary.tokensIn).toBe(100);
    expect(summary.tokensOut).toBe(50);
    expect(summary.uniqueUsers).toBe(1);
  });

  it('沒有資料時回傳 0 而不是錯誤', () => {
    expect(getGuildUsage(db, 'serverA', 7)).toEqual({
      requests: 0,
      tokensIn: 0,
      tokensOut: 0,
      uniqueUsers: 0,
    });
  });
});

describe('資料持久化（Planning §33 Restart Test）', () => {
  it('關閉再重開之後資料還在', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bot-test-'));
    const path = join(dir, 'bot.db');

    try {
      const first = createDatabase(path);
      upsertGuild(first.db, 'serverA', 'Server A');
      upsertUser(first.db, 'user123', 'Wayne');
      updateGuildSettings(first.db, 'serverA', { model: 'gemini-3.7-flash' });

      const conversation = getOrCreateConversation(first.db, 'serverA', 'chan1');
      appendUserMessage(first.db, conversation, 'user123', 'Wayne', '記住我喜歡 Qwen');
      first.connection.close();

      // 模擬重新啟動：重新開啟同一個檔案
      const second = createDatabase(path);
      const rows = getRecentMessages(
        second.db,
        getOrCreateConversation(second.db, 'serverA', 'chan1'),
        10,
      );

      expect(getGuildSettings(second.db, 'serverA')?.model).toBe('gemini-3.7-flash');
      expect(rows).toHaveLength(1);
      expect(rows[0]?.content).toBe('記住我喜歡 Qwen');
      expect(rows[0]?.username).toBe('Wayne');

      second.connection.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
