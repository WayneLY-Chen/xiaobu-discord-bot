import { UserFacingError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import {
  SEARCH_PROVIDER_LABEL,
  type SearchOptions,
  type SearchProvider,
  type SearchProviderId,
  type SearchResult,
} from './types.js';

export interface SearchOutcome {
  results: SearchResult[];
  provider: SearchProviderId;
  fellBack: boolean;
}

/**
 * 搜尋的換手邏輯，與 AiRouter 同一套想法：
 * 陣列順序就是優先順序，前面的失敗就換下一個免費來源。
 *
 * 預設順序是 Tavily → Gemini grounding：
 * Tavily 給乾淨網址與發布日期（符合規格 §12），但每月只有 1,000 次；
 * Gemini 每天有 500 次、額度大得多，但來源是 Google 轉址連結也沒有日期。
 * 所以用「品質好的先用，用完換額度大的」而不是反過來。
 */
export class SearchRouter {
  constructor(private readonly providers: SearchProvider[]) {}

  get available(): SearchProviderId[] {
    return this.providers.map((provider) => provider.id);
  }

  get enabled(): boolean {
    return this.providers.length > 0;
  }

  async search(query: string, options: SearchOptions): Promise<SearchOutcome> {
    if (this.providers.length === 0) {
      throw new UserFacingError('目前沒有可用的搜尋服務。');
    }

    let firstError: UserFacingError | undefined;

    for (const [index, provider] of this.providers.entries()) {
      try {
        const results = await provider.search(query, options);

        // 查得到但沒有結果是正常的（冷門查詢），不該換手浪費另一家的額度
        return { results, provider: provider.id, fellBack: index > 0 };
      } catch (error) {
        const failure =
          error instanceof UserFacingError
            ? error
            : new UserFacingError('搜尋服務暫時無法使用。', error);

        firstError ??= failure;

        const remaining = this.providers.length - index - 1;
        logger.warn(
          `${SEARCH_PROVIDER_LABEL[provider.id]} 搜尋失敗：${failure.message}` +
            (remaining > 0 ? `　改試下一個搜尋來源` : '　已無其他搜尋來源'),
        );
      }
    }

    throw firstError ?? new UserFacingError('搜尋服務暫時無法使用。');
  }
}
