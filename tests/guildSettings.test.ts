import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, type Db } from '../src/database/client.js';
import { upsertGuild } from '../src/database/repositories/identity.js';
import {
  ensureGuildSettings,
  resetGuildSettings,
  updateGuildSettings,
} from '../src/database/repositories/settings.js';

let db: Db;
let close: () => void;

beforeEach(() => {
  const created = createDatabase(':memory:');
  db = created.db;
  close = () => created.connection.close();
  upsertGuild(db, 'g1', 'Server');
});

afterEach(() => close());

describe('guild_settings 的功能開關', () => {
  it('第一次建立時語音是開的、生圖是關的', () => {
    const row = ensureGuildSettings(db, 'g1');

    // 生圖比聊天貴又容易被拿來刷圖，所以預設關；
    // 語音要有人主動 /voice join 才會啟動，所以預設開。
    expect(row.voiceEnabled).toBe(true);
    expect(row.imageEnabled).toBe(false);
  });

  it('關掉語音之後讀回來還是關的', () => {
    updateGuildSettings(db, 'g1', { voiceEnabled: false });
    expect(ensureGuildSettings(db, 'g1').voiceEnabled).toBe(false);
  });

  it('/settings reset 之後語音回到預設的開啟', () => {
    // reset 是砍掉整列再重建，所以它取的是 SQL 欄位預設值，
    // 不是 resolveSettings 裡的那個 ?? true —— 兩邊不一致的話只有這裡會抓到。
    updateGuildSettings(db, 'g1', { voiceEnabled: false });
    resetGuildSettings(db, 'g1');

    expect(ensureGuildSettings(db, 'g1').voiceEnabled).toBe(true);
  });
});
