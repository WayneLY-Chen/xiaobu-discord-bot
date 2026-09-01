import { describe, expect, it } from 'vitest';
import { resolveSettings } from '../src/config/resolveSettings.js';
import type { GuildSettingsRow, UserSettingsRow } from '../src/database/schema.js';

const defaults = { model: 'gemini-3.1-flash-lite', locale: 'zh-TW' } as const;

function guild(partial: Partial<GuildSettingsRow> = {}): GuildSettingsRow {
  return {
    guildId: 'g1',
    aiChannelId: null,
    model: null,
    systemPrompt: null,
    locale: null,
    chatEnabled: true,
    memoryEnabled: true,
    imageEnabled: false,
    musicEnabled: false,
    voiceEnabled: false,
    updatedAt: 0,
    ...partial,
  };
}

function user(partial: Partial<UserSettingsRow> = {}): UserSettingsRow {
  return {
    userId: 'u1',
    model: null,
    locale: null,
    personality: null,
    memoryEnabled: true,
    updatedAt: 0,
    ...partial,
  };
}

describe('resolveSettings', () => {
  it('沒有任何覆寫時使用系統預設', () => {
    const result = resolveSettings(undefined, undefined, defaults);

    expect(result.model).toBe('gemini-3.1-flash-lite');
    expect(result.locale).toBe('zh-TW');
  });

  it('伺服器設定覆寫系統預設', () => {
    const result = resolveSettings(guild({ model: 'gemini-2.5-flash' }), undefined, defaults);
    expect(result.model).toBe('gemini-2.5-flash');
  });

  it('個人設定優先於伺服器設定', () => {
    const result = resolveSettings(
      guild({ model: 'gemini-2.5-flash' }),
      user({ model: 'gemini-3.7-flash' }),
      defaults,
    );

    expect(result.model).toBe('gemini-3.7-flash');
  });

  it('資料庫存著已下架的 model 時退回預設，而不是讓 API 呼叫失敗', () => {
    const result = resolveSettings(
      guild({ model: 'gemini-1.0-pro-vision' }),
      user({ model: 'some-removed-model' }),
      defaults,
    );

    expect(result.model).toBe('gemini-3.1-flash-lite');
  });

  it('個人 model 無效時，仍然會採用伺服器的有效設定', () => {
    const result = resolveSettings(
      guild({ model: 'gemini-3.7-flash' }),
      user({ model: 'not-a-model' }),
      defaults,
    );

    expect(result.model).toBe('gemini-3.7-flash');
  });

  it('伺服器關閉聊天時，個人設定不能覆寫', () => {
    const result = resolveSettings(guild({ chatEnabled: false }), user(), defaults);
    expect(result.chatEnabled).toBe(false);
  });

  it('記憶功能兩邊都開才算開', () => {
    expect(resolveSettings(guild(), user(), defaults).memoryEnabled).toBe(true);
    expect(
      resolveSettings(guild({ memoryEnabled: false }), user(), defaults).memoryEnabled,
    ).toBe(false);
    expect(
      resolveSettings(guild(), user({ memoryEnabled: false }), defaults).memoryEnabled,
    ).toBe(false);
  });

  it('personality 來自使用者，systemPrompt 來自伺服器', () => {
    const result = resolveSettings(
      guild({ systemPrompt: '請用工程師口吻' }),
      user({ personality: '講短一點' }),
      defaults,
    );

    expect(result.systemPrompt).toBe('請用工程師口吻');
    expect(result.personality).toBe('講短一點');
  });
});
