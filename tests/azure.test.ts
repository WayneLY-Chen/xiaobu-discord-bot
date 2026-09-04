import { describe, expect, it } from 'vitest';
import { AzureTtsProvider, explainStatus } from '../src/voice/azure.js';

function provider(overrides: Partial<ConstructorParameters<typeof AzureTtsProvider>[0]> = {}) {
  return new AzureTtsProvider({
    apiKey: 'k',
    region: 'eastasia',
    voice: 'zh-CN-XiaoshuangNeural',
    pitch: 'default',
    rate: 'default',
    ...overrides,
  });
}

describe('Azure Speech', () => {
  it('沒設金鑰就不算可用 —— 整條路等於不存在，會直接用 Edge', async () => {
    expect(await provider({ apiKey: '' }).isAvailable()).toBe(false);
  });

  it('沒設區域也不算可用', async () => {
    expect(await provider({ region: '' }).isAvailable()).toBe(false);
  });

  it('金鑰與區域都有才啟用', async () => {
    expect(await provider().isAvailable()).toBe(true);
  });

  it('空白內容不會送出去浪費額度', async () => {
    await expect(provider().synthesize({ text: '   ', timeoutMs: 1000 })).rejects.toThrow(
      '沒有可以唸出來的內容',
    );
  });
});

describe('錯誤訊息要講得出差別', () => {
  it('429 是額度用完，不是設定錯誤', () => {
    expect(explainStatus(429)).toContain('額度');
    expect(explainStatus(429)).not.toContain('金鑰');
  });

  it('401 / 403 才是金鑰問題', () => {
    expect(explainStatus(401)).toContain('金鑰');
    expect(explainStatus(403)).toContain('金鑰');
  });

  it('400 通常是聲線名稱或區域不支援', () => {
    expect(explainStatus(400)).toContain('聲線');
  });

  it('其他狀態碼至少要把數字講出來', () => {
    expect(explainStatus(503)).toContain('503');
  });
});
