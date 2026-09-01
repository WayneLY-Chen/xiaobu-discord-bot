import { GoogleGenAI } from '@google/genai';
import {
  ContentBlockedError,
  ProviderAuthError,
  ProviderTimeoutError,
  QuotaExceededError,
  UserFacingError,
} from '../utils/errors.js';
import { logger } from '../utils/logger.js';

/** 送進模型的一輪對話。Gemini 用 'model' 表示 AI 那一方。 */
export interface ChatTurn {
  role: 'user' | 'model';
  text: string;
}

export interface ChatRequest {
  model: string;
  systemInstruction: string;
  history: ChatTurn[];
  maxOutputTokens: number;
  timeoutMs: number;
}

export interface ChatResponse {
  text: string;
  tokensIn: number;
  tokensOut: number;
}

/** ChatService 只依賴這個介面，方便測試，也方便 Phase 2 換成其他 provider。 */
export interface ChatProvider {
  chat(request: ChatRequest): Promise<ChatResponse>;
}

export class GeminiClient implements ChatProvider {
  private readonly ai: GoogleGenAI;

  constructor(apiKey: string) {
    this.ai = new GoogleGenAI({ apiKey });
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs);

    try {
      const response = await this.ai.models.generateContent({
        model: request.model,
        contents: request.history.map((turn) => ({
          role: turn.role,
          parts: [{ text: turn.text }],
        })),
        config: {
          systemInstruction: request.systemInstruction,
          maxOutputTokens: request.maxOutputTokens,
          abortSignal: controller.signal,
        },
      });

      const text = response.text?.trim() ?? '';

      if (text.length === 0) {
        // 空回應通常代表被安全機制擋下，或是 maxOutputTokens 太小
        throw new ContentBlockedError(
          `finishReason=${response.candidates?.[0]?.finishReason ?? 'unknown'}`,
        );
      }

      return {
        text,
        tokensIn: response.usageMetadata?.promptTokenCount ?? 0,
        tokensOut: response.usageMetadata?.candidatesTokenCount ?? 0,
      };
    } catch (error) {
      throw translateGeminiError(error);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * 把 SDK 的錯誤轉成使用者看得懂的錯誤。
 * 這裡刻意不做「自動換 provider」，Planning §30 要求 Phase 2 才處理 fallback，
 * 而且絕不能自動切到付費服務。
 */
function translateGeminiError(error: unknown): UserFacingError {
  if (error instanceof UserFacingError) return error;

  if (error instanceof Error && error.name === 'AbortError') {
    return new ProviderTimeoutError(error);
  }

  const status = extractStatus(error);
  const text = error instanceof Error ? error.message : String(error);

  if (status === 429 || /RESOURCE_EXHAUSTED|quota|rate limit/i.test(text)) {
    return new QuotaExceededError(error);
  }

  if (status === 401 || status === 403 || /API key|PERMISSION_DENIED|UNAUTHENTICATED/i.test(text)) {
    return new ProviderAuthError(error);
  }

  if (/SAFETY|blocked/i.test(text)) {
    return new ContentBlockedError(error);
  }

  logger.error('Gemini 未分類錯誤', error);
  return new UserFacingError('AI 服務暫時無法使用，請稍後再試。', error);
}

function extractStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;

  const candidate = error as { status?: unknown; code?: unknown };
  if (typeof candidate.status === 'number') return candidate.status;
  if (typeof candidate.code === 'number') return candidate.code;

  return undefined;
}
