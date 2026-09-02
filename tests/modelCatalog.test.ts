import { describe, expect, it } from 'vitest';
import {
  ALLOWED_MODELS,
  getModelSpec,
  isAllowedModel,
  MODEL_CATALOG,
  PROVIDER_DEFAULT_MODEL,
  PROVIDER_IDS,
  PROVIDER_LABEL,
} from '../src/config/constants.js';
import { MODEL_CHOICES } from '../src/commands/shared.js';

/** Discord 單一 slash command option 最多 25 個 choice，name 最長 100 字元。 */
const DISCORD_MAX_CHOICES = 25;
const DISCORD_MAX_CHOICE_NAME = 100;

describe('model catalog', () => {
  it('沒有重複的 model id', () => {
    const ids = MODEL_CATALOG.map((model) => model.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('每個 model 都指向已知的 provider，且該 provider 有中文名稱', () => {
    for (const model of MODEL_CATALOG) {
      expect(PROVIDER_IDS).toContain(model.provider);
      expect(PROVIDER_LABEL[model.provider]).toBeTruthy();
    }
  });

  it('每個 provider 至少有一個模型可選', () => {
    for (const id of PROVIDER_IDS) {
      expect(MODEL_CATALOG.some((model) => model.provider === id)).toBe(true);
    }
  });

  it('fallback 用的預設模型一定存在、屬於該 provider，而且是 production', () => {
    for (const id of PROVIDER_IDS) {
      const spec = getModelSpec(PROVIDER_DEFAULT_MODEL[id]);

      expect(spec, `${id} 的預設模型不在白名單中`).toBeDefined();
      expect(spec?.provider).toBe(id);
      // 換手是救命用的，不能指望一個官方標示「可能隨時下架」的 preview 模型
      expect(spec?.stability).toBe('production');
    }
  });

  it('preview 模型的標籤有標示風險，讓使用者選之前就知道', () => {
    for (const model of MODEL_CATALOG.filter((m) => m.stability === 'preview')) {
      expect(model.label).toContain('preview');
    }
  });

  it('ALLOWED_MODELS 與 catalog 一致', () => {
    expect([...ALLOWED_MODELS]).toEqual(MODEL_CATALOG.map((model) => model.id));
  });

  it('isAllowedModel 與 getModelSpec 對得起來', () => {
    expect(isAllowedModel('llama-3.3-70b-versatile')).toBe(true);
    expect(isAllowedModel('gpt-4o')).toBe(false);
    expect(getModelSpec('qwen/qwen3.6-27b')?.provider).toBe('groq');
    expect(getModelSpec('不存在的模型')).toBeUndefined();
  });

  it('選單沒有超出 Discord 的限制', () => {
    expect(MODEL_CHOICES.length).toBeLessThanOrEqual(DISCORD_MAX_CHOICES);

    for (const choice of MODEL_CHOICES) {
      expect(choice.name.length).toBeLessThanOrEqual(DISCORD_MAX_CHOICE_NAME);
      expect(choice.name.length).toBeGreaterThan(0);
    }
  });

  it('選單涵蓋整份白名單，外加一個「沿用上一層」選項', () => {
    expect(MODEL_CHOICES).toHaveLength(MODEL_CATALOG.length + 1);
  });
});
