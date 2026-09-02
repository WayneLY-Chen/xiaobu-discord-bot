import type { Env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import { GeminiSearchProvider } from './geminiGrounding.js';
import { SearchRouter } from './router.js';
import { TavilySearchProvider } from './tavily.js';
import { SEARCH_PROVIDER_LABEL, type SearchProvider } from './types.js';

/**
 * 依環境變數組出搜尋來源。
 *
 * **陣列順序就是優先順序**，這裡刻意是 Tavily → Gemini：
 * Tavily 給乾淨網址與發布日期（符合規格 §12 對來源的要求），但每月只有 1,000 次；
 * Gemini grounding 每天有 500 次、額度大得多，但來源是 Google 轉址連結、沒有日期。
 * 所以「品質好的先用，用完換額度大的」。
 *
 * 兩個都沒有設定時搜尋工具不會提供給模型，聊天本身不受影響。
 */
export function createSearchRouter(env: Env): SearchRouter {
  const providers: SearchProvider[] = [];

  if (env.TAVILY_API_KEY) providers.push(new TavilySearchProvider(env.TAVILY_API_KEY));
  if (env.GEMINI_API_KEY) providers.push(new GeminiSearchProvider(env.GEMINI_API_KEY));

  logger.info(
    `已啟用的搜尋來源：${providers.map((p) => SEARCH_PROVIDER_LABEL[p.id]).join('、') || '（無，搜尋功能停用）'}`,
  );

  return new SearchRouter(providers);
}
