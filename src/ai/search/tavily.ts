import { ProviderAuthError, ProviderTimeoutError, QuotaExceededError, UserFacingError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import type { SearchOptions, SearchProvider, SearchResult } from './types.js';

const TAVILY_URL = 'https://api.tavily.com/search';

interface TavilyResponse {
  results?: {
    title?: string;
    url?: string;
    content?: string;
    published_date?: string;
  }[];
  detail?: { error?: string } | string;
}

/**
 * Tavily 搜尋（2026-09 查證）。
 *
 * 免費層每月 1,000 credits，每月 1 號重置，不需要綁信用卡。
 * 回傳的是乾淨的原始網址，新聞類查詢還會附 published_date ——
 * 這點比 Gemini grounding 好（那邊給的是 Google 轉址連結、沒有日期），
 * 所以拿它當預設，額度用完再換 Gemini。
 */
export class TavilySearchProvider implements SearchProvider {
  readonly id = 'tavily' as const;

  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly apiKey: string,
    fetchImpl?: typeof fetch,
  ) {
    this.fetchImpl = fetchImpl ?? fetch;
  }

  async search(query: string, options: SearchOptions): Promise<SearchResult[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);

    try {
      const response = await this.fetchImpl(TAVILY_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          query,
          max_results: options.maxResults,
          // basic 一次算 1 credit，advanced 算 2。免費層一個月只有 1,000，用 basic 就夠了
          search_depth: 'basic',
          topic: options.recentOnly ? 'news' : 'general',
          include_answer: false,
          include_raw_content: false,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw this.translateHttpError(response.status);
      }

      const payload = (await response.json()) as TavilyResponse;

      return (payload.results ?? [])
        .filter((row): row is { title: string; url: string; content?: string; published_date?: string } =>
          typeof row.url === 'string' && row.url.length > 0 && typeof row.title === 'string',
        )
        .map((row) => ({
          title: row.title,
          url: row.url,
          snippet: (row.content ?? '').trim(),
          ...(row.published_date ? { publishedAt: row.published_date } : {}),
        }));
    } catch (error) {
      throw translateError(error);
    } finally {
      clearTimeout(timer);
    }
  }

  private translateHttpError(status: number): UserFacingError {
    // 432 是 Tavily 用來表示額度用完的自訂狀態碼
    if (status === 429 || status === 432) return new QuotaExceededError(`Tavily HTTP ${status}`);
    if (status === 401 || status === 403) return new ProviderAuthError(`Tavily HTTP ${status}`);

    logger.error(`Tavily 回應 HTTP ${status}`);
    return new UserFacingError('搜尋服務暫時無法使用。', `HTTP ${status}`);
  }
}

function translateError(error: unknown): UserFacingError {
  if (error instanceof UserFacingError) return error;

  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return new ProviderTimeoutError(error);
  }

  logger.error('Tavily 未分類錯誤', error);
  return new UserFacingError('搜尋服務暫時無法使用。', error);
}
