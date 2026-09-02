export const SEARCH_PROVIDER_IDS = ['tavily', 'gemini'] as const;
export type SearchProviderId = (typeof SEARCH_PROVIDER_IDS)[number];

export const SEARCH_PROVIDER_LABEL = {
  tavily: 'Tavily',
  gemini: 'Google 搜尋',
} as const satisfies Record<SearchProviderId, string>;

/**
 * 一筆搜尋結果。
 *
 * 規格 §12 要求搜尋結果必須有來源、標題、URL，日期則是「API 提供才顯示」。
 * 因此 title / url 是必填，publishedAt 可選 —— 不會為了湊格式去猜日期。
 */
export interface SearchResult {
  title: string;
  url: string;
  /** 摘要片段，可能是空字串。 */
  snippet: string;
  /** API 有給才有；沒有就不顯示，不要編。 */
  publishedAt?: string;
}

export interface SearchOptions {
  maxResults: number;
  timeoutMs: number;
  /** 偏新聞類的查詢會要求 provider 回傳日期。 */
  recentOnly?: boolean;
}

export interface SearchProvider {
  readonly id: SearchProviderId;
  search(query: string, options: SearchOptions): Promise<SearchResult[]>;
}
