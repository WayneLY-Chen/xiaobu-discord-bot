import { describe, expect, it } from 'vitest';
import { SearchRouter } from '../src/ai/search/router.js';
import type { SearchProvider, SearchProviderId, SearchResult } from '../src/ai/search/types.js';
import { QuotaExceededError, UserFacingError } from '../src/utils/errors.js';

class StubSearch implements SearchProvider {
  calls = 0;

  constructor(
    readonly id: SearchProviderId,
    private readonly outcome: SearchResult[] | Error,
  ) {}

  async search(): Promise<SearchResult[]> {
    this.calls += 1;
    if (this.outcome instanceof Error) throw this.outcome;
    return this.outcome;
  }
}

const hit: SearchResult[] = [{ title: 'T', url: 'https://example.com', snippet: 's' }];
const options = { maxResults: 5, timeoutMs: 1000 };

describe('SearchRouter', () => {
  it('用第一個來源就成功時不會動到第二個', async () => {
    const tavily = new StubSearch('tavily', hit);
    const gemini = new StubSearch('gemini', hit);

    const outcome = await new SearchRouter([tavily, gemini]).search('q', options);

    expect(outcome.provider).toBe('tavily');
    expect(outcome.fellBack).toBe(false);
    expect(gemini.calls).toBe(0);
  });

  it('Tavily 額度用完時換 Gemini 接手', async () => {
    const tavily = new StubSearch('tavily', new QuotaExceededError());
    const gemini = new StubSearch('gemini', hit);

    const outcome = await new SearchRouter([tavily, gemini]).search('q', options);

    expect(outcome.provider).toBe('gemini');
    expect(outcome.fellBack).toBe(true);
    expect(outcome.results).toEqual(hit);
  });

  it('查得到但沒有結果算成功，不會浪費第二個來源的額度', async () => {
    const tavily = new StubSearch('tavily', []);
    const gemini = new StubSearch('gemini', hit);

    const outcome = await new SearchRouter([tavily, gemini]).search('冷門關鍵字', options);

    expect(outcome.results).toEqual([]);
    expect(outcome.provider).toBe('tavily');
    expect(gemini.calls).toBe(0);
  });

  it('全部失敗時回報第一個錯誤', async () => {
    const router = new SearchRouter([
      new StubSearch('tavily', new QuotaExceededError()),
      new StubSearch('gemini', new UserFacingError('別的問題')),
    ]);

    await expect(router.search('q', options)).rejects.toThrow(QuotaExceededError);
  });

  it('沒有任何來源時 enabled 是 false，呼叫會直接報錯', async () => {
    const router = new SearchRouter([]);

    expect(router.enabled).toBe(false);
    await expect(router.search('q', options)).rejects.toThrow('沒有可用的搜尋服務');
  });

  it('available 列出目前的來源順序', () => {
    const router = new SearchRouter([new StubSearch('tavily', hit), new StubSearch('gemini', hit)]);

    expect(router.available).toEqual(['tavily', 'gemini']);
    expect(router.enabled).toBe(true);
  });
});
