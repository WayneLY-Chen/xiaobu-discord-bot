import type { ProviderId } from '../../config/constants.js';
import {
  ContentBlockedError,
  ProviderAuthError,
  ProviderTimeoutError,
  QuotaExceededError,
  UserFacingError,
} from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import { CHAT_ONLY, type ChatProvider, type ChatRequest, type ChatResponse } from './types.js';

export interface OpenAiCompatibleOptions {
  id: ProviderId;
  tier: 'free' | 'paid';
  /** 不含結尾斜線，例如 https://api.groq.com/openai/v1 */
  baseUrl: string;
  apiKey: string;
  /** 顯示在 log 中的名稱。 */
  label: string;
  /** 測試用；預設使用全域 fetch。 */
  fetchImpl?: typeof fetch;
}

interface ChatCompletionResponse {
  choices?: {
    message?: { content?: string | null };
    finish_reason?: string;
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
  error?: { message?: string; type?: string; code?: string };
}

/**
 * OpenAI Chat Completions 相容端點的共用實作。
 *
 * Groq 用這個；之後要接 OpenRouter、Together 之類的也只是換 baseUrl，
 * 不需要再寫一份。刻意用內建 fetch 而不是 openai 套件，
 * 省下一個相依套件與 Docker image 體積。
 */
export class OpenAiCompatibleProvider implements ChatProvider {
  readonly id: ProviderId;
  readonly tier: 'free' | 'paid';
  readonly capabilities = CHAT_ONLY;

  private readonly options: OpenAiCompatibleOptions;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAiCompatibleOptions) {
    this.options = options;
    this.id = options.id;
    this.tier = options.tier;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs);

    try {
      const response = await this.fetchImpl(`${this.options.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.options.apiKey}`,
        },
        // 注意：不送 messages[].name。Groq 收到這個欄位會直接回 400。
        // 說話者是用內文的 `[名字]` 前綴表示的（見 src/ai/context.ts）。
        body: JSON.stringify({
          model: request.model,
          messages: [
            { role: 'system', content: request.systemInstruction },
            ...request.history.map((turn) => ({
              role: turn.role === 'model' ? 'assistant' : 'user',
              content: turn.text,
            })),
          ],
          max_tokens: request.maxOutputTokens,
          stream: false,
        }),
        signal: controller.signal,
      });

      const payload = await this.readJson(response);

      if (!response.ok) {
        throw this.translateHttpError(response.status, payload);
      }

      const choice = payload.choices?.[0];
      const text = choice?.message?.content?.trim() ?? '';

      if (text.length === 0) {
        // 空內容多半是被內容過濾擋下，或 max_tokens 太小導致還沒吐字就停了
        throw new ContentBlockedError(`finish_reason=${choice?.finish_reason ?? 'unknown'}`);
      }

      return {
        text,
        tokensIn: payload.usage?.prompt_tokens ?? 0,
        tokensOut: payload.usage?.completion_tokens ?? 0,
      };
    } catch (error) {
      throw this.translateError(error);
    } finally {
      clearTimeout(timer);
    }
  }

  /** 端點壞掉時可能回 HTML 或空字串，不能假設一定是 JSON。 */
  private async readJson(response: Response): Promise<ChatCompletionResponse> {
    try {
      return (await response.json()) as ChatCompletionResponse;
    } catch {
      return {};
    }
  }

  private translateHttpError(status: number, payload: ChatCompletionResponse): UserFacingError {
    const detail = payload.error?.message ?? `HTTP ${status}`;

    if (status === 429) return new QuotaExceededError(detail);
    if (status === 401 || status === 403) return new ProviderAuthError(detail);
    if (status === 400 && /content|filter|policy/i.test(detail)) {
      return new ContentBlockedError(detail);
    }

    logger.error(`${this.options.label} 回應 HTTP ${status}`, detail);
    return new UserFacingError('AI 服務暫時無法使用，請稍後再試。', detail);
  }

  private translateError(error: unknown): UserFacingError {
    if (error instanceof UserFacingError) return error;

    if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
      return new ProviderTimeoutError(error);
    }

    logger.error(`${this.options.label} 未分類錯誤`, error);
    return new UserFacingError('AI 服務暫時無法使用，請稍後再試。', error);
  }
}
