import { GoogleGenAI } from '@google/genai';
import {
  ProviderAuthError,
  ProviderTimeoutError,
  QuotaExceededError,
  UserFacingError,
} from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import type { SearchOptions, SearchProvider, SearchResult } from './types.js';

/**
 * 免費的 grounding 只給 Gemini 2.5 系列（2026-09 查證的官方定價頁）：
 *
 *   gemini-2.5-flash / 2.5-flash-lite  →  Free of charge, up to 500 RPD
 *   gemini-3.x 全系列                  →  Not available
 *
 * 所以這裡寫死用 2.5-flash-lite，與使用者聊天時選的模型無關 ——
 * 就算主回答是 Groq 回的，搜尋一樣可以用。
 *
 * ⚠️ 免費資格綁在舊版模型上，哪天 2.5 下架這條路就沒了，
 * 這也是預設用 Tavily、這裡只當備援的原因。
 */
const GROUNDING_MODEL = 'gemini-2.5-flash-lite';

export class GeminiSearchProvider implements SearchProvider {
  readonly id = 'gemini' as const;

  private readonly ai: GoogleGenAI;

  constructor(apiKey: string) {
    this.ai = new GoogleGenAI({ apiKey });
  }

  async search(query: string, options: SearchOptions): Promise<SearchResult[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);

    try {
      const response = await this.ai.models.generateContent({
        model: GROUNDING_MODEL,
        contents: [{ role: 'user', parts: [{ text: query }] }],
        config: {
          tools: [{ googleSearch: {} }],
          abortSignal: controller.signal,
          // 只要來源清單，不需要它寫長篇大論
          maxOutputTokens: 512,
          systemInstruction: '用一兩句話回答，重點是查到可靠的來源。',
        },
      });

      const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];

      const results: SearchResult[] = [];
      const seen = new Set<string>();

      for (const chunk of chunks) {
        const uri = chunk.web?.uri;
        if (!uri || seen.has(uri)) continue;
        seen.add(uri);

        results.push({
          title: chunk.web?.title ?? uri,
          url: uri,
          // grounding 不會給每個來源的摘要，只有整體的 response.text。
          // 與其硬塞一段可能對不上這個來源的文字，不如留空 —— 規格明令不得捏造來源。
          snippet: '',
        });

        if (results.length >= options.maxResults) break;
      }

      // grounding 沒有回來源時，至少把模型查到的答案本身當成一筆結果傳回去
      if (results.length === 0) {
        const text = response.text?.trim();
        if (text) return [{ title: 'Google 搜尋摘要', url: '', snippet: text }];
      }

      return results;
    } catch (error) {
      throw translateError(error);
    } finally {
      clearTimeout(timer);
    }
  }
}

function translateError(error: unknown): UserFacingError {
  if (error instanceof UserFacingError) return error;

  if (error instanceof Error && error.name === 'AbortError') {
    return new ProviderTimeoutError(error);
  }

  const text = error instanceof Error ? error.message : String(error);
  const status = extractStatus(error);

  if (status === 429 || /RESOURCE_EXHAUSTED|quota|rate limit/i.test(text)) {
    return new QuotaExceededError(error);
  }

  if (status === 401 || status === 403 || /API key|PERMISSION_DENIED|UNAUTHENTICATED/i.test(text)) {
    return new ProviderAuthError(error);
  }

  logger.error('Gemini grounding 未分類錯誤', error);
  return new UserFacingError('搜尋服務暫時無法使用。', error);
}

function extractStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;

  const candidate = error as { status?: unknown; code?: unknown };
  if (typeof candidate.status === 'number') return candidate.status;
  if (typeof candidate.code === 'number') return candidate.code;

  return undefined;
}
