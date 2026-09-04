import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, type Db } from '../src/database/client.js';
import { upsertGuild, upsertUser } from '../src/database/repositories/identity.js';
import {
  appendAssistantMessage,
  appendUserMessage,
  clearConversation,
  getOrCreateConversation,
  getRecentMessages,
  pruneOldMessages,
} from '../src/database/repositories/conversations.js';
import { messages } from '../src/database/schema.js';
import { sql } from 'drizzle-orm';

const DAY_MS = 24 * 60 * 60 * 1000;

let db: Db;
let close: () => void;

beforeEach(() => {
  const created = createDatabase(':memory:');
  db = created.db;
  close = () => created.connection.close();
  upsertGuild(db, 'g1', 'Server');
  upsertUser(db, 'u1', 'Wayne');
});

afterEach(() => close());

/** created_at 存的是 unixepoch 秒，測試要能把訊息「調老」。 */
function ageAllMessages(days: number): void {
  db.run(sql`UPDATE messages SET created_at = created_at - ${days * 24 * 60 * 60}`);
}

describe('訊息保留期', () => {
  it('超過保留期的訊息會被刪掉', () => {
    const id = getOrCreateConversation(db, 'g1', 'c1');
    appendUserMessage(db, id, 'u1', 'Wayne', '很久以前說的話');
    appendAssistantMessage(db, id, '很久以前的回覆');
    ageAllMessages(40);

    expect(pruneOldMessages(db, 30 * DAY_MS)).toBe(2);
    expect(getRecentMessages(db, id, 10)).toHaveLength(0);
  });

  it('保留期內的訊息不會動到', () => {
    const id = getOrCreateConversation(db, 'g1', 'c1');
    appendUserMessage(db, id, 'u1', 'Wayne', '剛剛說的話');
    ageAllMessages(3);

    expect(pruneOldMessages(db, 30 * DAY_MS)).toBe(0);
    expect(getRecentMessages(db, id, 10)).toHaveLength(1);
  });

  it('只刪過期的那些，新的留著', () => {
    const id = getOrCreateConversation(db, 'g1', 'c1');
    appendUserMessage(db, id, 'u1', 'Wayne', '舊的');
    ageAllMessages(40);
    appendUserMessage(db, id, 'u1', 'Wayne', '新的');

    expect(pruneOldMessages(db, 30 * DAY_MS)).toBe(1);
    const left = getRecentMessages(db, id, 10);
    expect(left).toHaveLength(1);
    expect(left[0]?.content).toBe('新的');
  });

  it('保留天數設 0 代表永久保留，什麼都不刪', () => {
    const id = getOrCreateConversation(db, 'g1', 'c1');
    appendUserMessage(db, id, 'u1', 'Wayne', '很舊的話');
    ageAllMessages(3650);

    expect(pruneOldMessages(db, 0)).toBe(0);
    expect(getRecentMessages(db, id, 10)).toHaveLength(1);
  });

  it('訊息被清光的對話串也一起收掉，不留孤兒', () => {
    const id = getOrCreateConversation(db, 'g1', 'c1');
    appendUserMessage(db, id, 'u1', 'Wayne', '舊的');
    ageAllMessages(40);
    pruneOldMessages(db, 30 * DAY_MS);

    // 同一個頻道再開一次對話，拿到的應該是新的 id
    expect(getOrCreateConversation(db, 'g1', 'c1')).not.toBe(id);
    expect(db.select().from(messages).all()).toHaveLength(0);
  });
});

describe('掃描與進行中的回覆同時發生', () => {
  it('對話串被 /reset + 掃描收掉之後，重新取一次 id 就能繼續寫入', () => {
    // 這是 chatService 修法依賴的性質：id 不能抱過 await，要重新取。
    // 沒有這一步的話，答案已經生出來、額度已經花掉，卻會撞 FOREIGN KEY 整段丟掉。
    const id = getOrCreateConversation(db, 'g1', 'c1');
    appendUserMessage(db, id, 'u1', 'Wayne', '問題');

    // /reset 清空訊息但留下父列，接著保留期掃描把空的父列收掉
    clearConversation(db, 'g1', 'c1');
    pruneOldMessages(db, 30 * DAY_MS);

    const liveId = getOrCreateConversation(db, 'g1', 'c1');
    expect(liveId).not.toBe(id);
    expect(() => appendAssistantMessage(db, liveId, '回答')).not.toThrow();
    expect(getRecentMessages(db, liveId, 10)).toHaveLength(1);
  });

  it('沿用舊 id 會失敗 —— 這就是原本的 bug', () => {
    const id = getOrCreateConversation(db, 'g1', 'c1');
    appendUserMessage(db, id, 'u1', 'Wayne', '問題');
    clearConversation(db, 'g1', 'c1');
    pruneOldMessages(db, 30 * DAY_MS);

    expect(() => appendAssistantMessage(db, id, '回答')).toThrow();
  });
});
