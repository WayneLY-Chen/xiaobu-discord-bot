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
      const text = stripReasoning(choice?.message?.content ?? '');

      if (text.length === 0) {
        throw explainEmptyResponse(choice?.finish_reason);
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

/**
 * 推理型模型（gpt-oss、Qwen 的 thinking 版本）有兩種放推理過程的方式：
 * 放在獨立的 `reasoning` 欄位，或直接夾在 content 的 <think>…</think> 裡。
 * 前者我們本來就不會讀到，後者要自己清掉 —— Discord 使用者要的是答案，不是草稿。
 *
 * 也處理被截斷、沒有結束標籤的情況：那種內容全是推理，清掉後會是空字串，
 * 交給 explainEmptyResponse 判斷成長度不足，而不是誤報成內容被擋。
 */
export function stripReasoning(content: string): string {
  return content
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*$/i, '')
    .trim();
}

function explainEmptyResponse(finishReason: string | undefined): UserFacingError {
  // 推理型模型可能把整個 token 預算花在思考上，一個字都還沒吐出來就被截斷。
  // 這是輸出長度問題，不是內容被擋 —— 必須讓 Router 有機會換手到別家，
  // 因為 ContentBlockedError 會被 Router 當成「不該重試」而直接往上拋。
  if (finishReason === 'length') {
    return new UserFacingError(
      'AI 這次沒有產生出內容（推理佔滿了輸出長度），請再試一次或換一個模型。',
      'finish_reason=length',
    );
  }

  return new ContentBlockedError(`finish_reason=${finishReason ?? 'unknown'}`);
}
