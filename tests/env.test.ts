import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env.js';

const base = {
  DISCORD_TOKEN: 'token',
  DISCORD_CLIENT_ID: '123',
};

describe('環境變數驗證', () => {
  it('兩個 provider 的 Key 都沒設時直接擋下啟動', () => {
    expect(() => loadEnv({ ...base })).toThrow(/至少要設定一個 AI provider/);
  });

  it('空字串不算有設定 —— .env 裡留白的那一行不該被當成有效 Key', () => {
    expect(() => loadEnv({ ...base, GEMINI_API_KEY: '   ' })).toThrow(
      /至少要設定一個 AI provider/,
    );
  });

  it('只設定 Gemini 就能啟動', () => {
    const env = loadEnv({ ...base, GEMINI_API_KEY: 'g-key' });

    expect(env.GEMINI_API_KEY).toBe('g-key');
    expect(env.GROQ_API_KEY).toBeUndefined();
    expect(env.DEFAULT_MODEL).toBe('gemini-3.1-flash-lite');
  });

  it('只設定 Groq 時，預設模型必須跟著改成 Groq 的模型', () => {
    expect(() => loadEnv({ ...base, GROQ_API_KEY: 'q-key' })).toThrow(
      /屬於 Gemini，但沒有設定它的 API Key/,
    );

    const env = loadEnv({
      ...base,
      GROQ_API_KEY: 'q-key',
      DEFAULT_MODEL: 'llama-3.3-70b-versatile',
    });

    expect(env.DEFAULT_MODEL).toBe('llama-3.3-70b-versatile');
  });

  it('白名單外的模型不接受', () => {
    expect(() => loadEnv({ ...base, GEMINI_API_KEY: 'g-key', DEFAULT_MODEL: 'gpt-4o' })).toThrow(
      /DEFAULT_MODEL/,
    );
  });

  it('付費 provider 與 fallback 的預設值符合規格', () => {
    const env = loadEnv({ ...base, GEMINI_API_KEY: 'g-key' });

    // Planning §30：預設禁止付費 provider
    expect(env.ALLOW_PAID_PROVIDERS).toBe(false);
    // 免費 provider 之間的換手則預設開啟
    expect(env.AI_FALLBACK_ENABLED).toBe(true);
  });

  it('可以明確關閉 fallback', () => {
    const env = loadEnv({ ...base, GEMINI_API_KEY: 'g-key', AI_FALLBACK_ENABLED: 'false' });

    expect(env.AI_FALLBACK_ENABLED).toBe(false);
  });

  it('錯誤訊息會列出每一個有問題的欄位，方便對照 .env.example', () => {
    expect(() => loadEnv({ DISCORD_TOKEN: '', DISCORD_CLIENT_ID: '' })).toThrow(
      /DISCORD_TOKEN[\s\S]*DISCORD_CLIENT_ID/,
    );
  });
});
