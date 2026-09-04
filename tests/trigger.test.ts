import { describe, expect, it } from 'vitest';
import { isUsableTriggerPhrase, normalizeForMatch } from '../src/utils/textMatch.js';
import { matchTrigger } from '../src/database/repositories/guildTriggers.js';
import type { GuildTriggerRow } from '../src/database/schema.js';

function row(id: number, phraseRaw: string, response = '台詞'): GuildTriggerRow {
  return {
    id,
    guildId: 'G1',
    phrase: normalizeForMatch(phraseRaw),
    phraseRaw,
    response,
    createdBy: 'U1',
    createdAt: 0,
  };
}

describe('觸發詞的正規化', () => {
  it('簡繁互通 —— 觸發詞用繁體設，簡體打字也要命中', () => {
    expect(normalizeForMatch('窗外的天气')).toBe(normalizeForMatch('窗外的天氣'));
  });

  it('英文不分大小寫', () => {
    expect(normalizeForMatch('Hello')).toBe(normalizeForMatch('hELLO'));
  });

  it('全形英數會被攤平成半形', () => {
    expect(normalizeForMatch('ＷＩＮＤＯＷ')).toBe(normalizeForMatch('window'));
  });

  it('空白多寡不影響', () => {
    expect(normalizeForMatch('窗外  的 天氣')).toBe(normalizeForMatch('窗外的天氣'));
  });
});

describe('退化的觸發詞會被擋下', () => {
  it('空字串不可用 —— includes("") 對每一則訊息都成立', () => {
    expect(isUsableTriggerPhrase('')).toBe(false);
  });

  it('單一字元不可用', () => {
    expect(isUsableTriggerPhrase(normalizeForMatch('的'))).toBe(false);
  });

  it('只有標點不可用', () => {
    expect(isUsableTriggerPhrase(normalizeForMatch('，。！'))).toBe(false);
    expect(isUsableTriggerPhrase(normalizeForMatch('...'))).toBe(false);
  });

  it('正常的詞可用', () => {
    expect(isUsableTriggerPhrase(normalizeForMatch('窗外的天氣'))).toBe(true);
  });
});

describe('matchTrigger', () => {
  const rows = [row(1, '天氣', '短的'), row(2, '窗外的天氣', '長的')];

  it('沒命中就回 null', () => {
    expect(matchTrigger(rows, '今天吃什麼')).toBeNull();
  });

  it('子字串命中', () => {
    expect(matchTrigger(rows, '欸你看今天天氣不錯耶')?.response).toBe('短的');
  });

  it('同時命中兩條時取最長的觸發詞，不是資料庫順序', () => {
    // 只取最新的話，設了「天氣」之後就再也觸發不到「窗外的天氣」
    expect(matchTrigger(rows, '你看窗外的天氣')?.response).toBe('長的');
  });

  it('簡體訊息也命中繁體的觸發詞', () => {
    expect(matchTrigger(rows, '你看窗外的天气')?.response).toBe('長的');
  });

  it('沒有任何觸發詞時回 null', () => {
    expect(matchTrigger([], '窗外的天氣')).toBeNull();
  });
});
