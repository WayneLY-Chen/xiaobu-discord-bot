import type { Env } from '../../config/env.js';
import { PROVIDER_LABEL } from '../../config/constants.js';
import { logger } from '../../utils/logger.js';
import { GeminiClient } from './gemini.js';
import { createGroqProvider } from './groq.js';
import type { ChatProvider } from './types.js';

/**
 * 依環境變數組出可用的 provider。
 *
 * **陣列順序就是優先順序**：第一個是預設主力，後面的依序當 fallback。
 * 沒設 API Key 的 provider 不會被建立，Router 也就不會把請求送過去。
 */
export function createProviders(env: Env): ChatProvider[] {
  const providers: ChatProvider[] = [];

  if (env.GEMINI_API_KEY) providers.push(new GeminiClient(env.GEMINI_API_KEY));
  if (env.GROQ_API_KEY) providers.push(createGroqProvider(env.GROQ_API_KEY));

  logger.info(
    `已啟用的 AI provider：${providers.map((p) => PROVIDER_LABEL[p.id]).join('、') || '（無）'}`,
  );

  return providers;
}
