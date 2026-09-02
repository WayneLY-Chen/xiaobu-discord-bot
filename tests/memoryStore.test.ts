import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, type Db } from '../src/database/client.js';
import { guilds } from '../src/database/schema.js';
import { upsertGuild, upsertUser } from '../src/database/repositories/identity.js';
import {
  addMemory,
  clearMemories,
  deleteMemory,
  listMemories,
  MAX_MEMORIES_PER_USER,
} from '../src/database/repositories/memories.js';
import {
  addGuildFact,
  clearGuildFacts,
  listGuildFacts,
  MAX_FACTS_PER_GUILD,
  removeGuildFact,
} from '../src/database/repositories/guildFacts.js';

let db: Db;
let close: () => void;

beforeEach(() => {
  const created = createDatabase(':memory:');
  db = created.db;
  close = () => created.connection.close();

  upsertGuild(db, 'serverA', 'Server A');
  upsertGuild(db, 'serverB', 'Server B');
  upsertUser(db, 'wayne', 'Wayne');
  upsertUser(db, 'ming', 'Ming');
});

afterEach(() => close());

describe('長期記憶', () => {
  it('存進去就讀得回來', () => {
    addMemory(db, 'serverA', 'wayne', '喜歡 Qwen');

    expect(listMemories(db, 'serverA', 'wayne').map((row) => row.content)).toEqual(['喜歡 Qwen']);
  });

  it('同一個人在不同伺服器是兩份，互不互通（規格 §17）', () => {
    addMemory(db, 'serverA', 'wayne', 'A 伺服器的祕密');

    expect(listMemories(db, 'serverB', 'wayne')).toHaveLength(0);
  });

  it('同一個伺服器的不同人也互不互通', () => {
    addMemory(db, 'serverA', 'wayne', 'Wayne 的事');

    expect(listMemories(db, 'serverA', 'ming')).toHaveLength(0);
  });

  it('重複的內容不會存第二次', () => {
    addMemory(db, 'serverA', 'wayne', '喜歡 Qwen');
    const second = addMemory(db, 'serverA', 'wayne', '喜歡 Qwen');

    expect(second.status).toBe('duplicate');
    expect(listMemories(db, 'serverA', 'wayne')).toHaveLength(1);
  });

  it('達到上限後拒絕新增，而不是無限長大把 context 撐爆', () => {
    for (let i = 0; i < MAX_MEMORIES_PER_USER; i += 1) {
      expect(addMemory(db, 'serverA', 'wayne', `記憶 ${i}`).status).toBe('added');
    }

    expect(addMemory(db, 'serverA', 'wayne', '再一則').status).toBe('full');
    expect(listMemories(db, 'serverA', 'wayne')).toHaveLength(MAX_MEMORIES_PER_USER);
  });

  it('過長的內容會被截斷', () => {
    addMemory(db, 'serverA', 'wayne', 'a'.repeat(500));

    expect(listMemories(db, 'serverA', 'wayne')[0]?.content).toHaveLength(300);
  });

  it('刪不到別人的記憶', () => {
    addMemory(db, 'serverA', 'wayne', 'Wayne 的事');
    const id = listMemories(db, 'serverA', 'wayne')[0]?.id ?? 0;

    expect(deleteMemory(db, 'serverA', 'ming', id)).toBe(false);
    expect(deleteMemory(db, 'serverB', 'wayne', id)).toBe(false);
    expect(deleteMemory(db, 'serverA', 'wayne', id)).toBe(true);
  });

  it('清空只影響自己在這個伺服器的記憶', () => {
    addMemory(db, 'serverA', 'wayne', 'A');
    addMemory(db, 'serverB', 'wayne', 'B');
    addMemory(db, 'serverA', 'ming', 'C');

    expect(clearMemories(db, 'serverA', 'wayne')).toBe(1);
    expect(listMemories(db, 'serverB', 'wayne')).toHaveLength(1);
    expect(listMemories(db, 'serverA', 'ming')).toHaveLength(1);
  });

  it('最新的排最前面', () => {
    addMemory(db, 'serverA', 'wayne', '舊的');
    addMemory(db, 'serverA', 'wayne', '新的');

    expect(listMemories(db, 'serverA', 'wayne')[0]?.content).toBe('新的');
  });
});

describe('伺服器共用背景知識', () => {
  it('整個伺服器共用，不分使用者', () => {
    addGuildFact(db, 'serverA', '週會在每週三', 'wayne');

    expect(listGuildFacts(db, 'serverA').map((row) => row.content)).toEqual(['週會在每週三']);
  });

  it('不同伺服器互不互通', () => {
    addGuildFact(db, 'serverA', 'A 的規則', 'wayne');

    expect(listGuildFacts(db, 'serverB')).toHaveLength(0);
  });

  it('記錄是誰新增的，出事查得到', () => {
    addGuildFact(db, 'serverA', '某件事', 'wayne');

    expect(listGuildFacts(db, 'serverA')[0]?.createdBy).toBe('wayne');
  });

  it('重複與上限的處理跟記憶一致', () => {
    addGuildFact(db, 'serverA', '重複', 'wayne');
    expect(addGuildFact(db, 'serverA', '重複', 'ming').status).toBe('duplicate');

    for (let i = 1; i < MAX_FACTS_PER_GUILD; i += 1) {
      addGuildFact(db, 'serverA', `事實 ${i}`, 'wayne');
    }

    expect(addGuildFact(db, 'serverA', '滿了', 'wayne').status).toBe('full');
  });

  it('刪除只作用在自己的伺服器', () => {
    addGuildFact(db, 'serverA', '某件事', 'wayne');
    const id = listGuildFacts(db, 'serverA')[0]?.id ?? 0;

    expect(removeGuildFact(db, 'serverB', id)).toBe(false);
    expect(removeGuildFact(db, 'serverA', id)).toBe(true);
  });

  it('Bot 被踢出伺服器時，背景知識會跟著 guild 一起被清掉', () => {
    addGuildFact(db, 'serverA', '某件事', 'wayne');

    // guild_facts 有 ON DELETE CASCADE 指向 guilds
    db.delete(guilds).where(eq(guilds.id, 'serverA')).run();

    expect(listGuildFacts(db, 'serverA')).toHaveLength(0);
  });

  it('clearGuildFacts 回傳刪掉幾條', () => {
    addGuildFact(db, 'serverA', 'a', 'wayne');
    addGuildFact(db, 'serverA', 'b', 'wayne');

    expect(clearGuildFacts(db, 'serverA')).toBe(2);
  });
});
