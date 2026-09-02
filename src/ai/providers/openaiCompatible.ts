import type { ProviderId } from '../../config/constants.js';
import {
  ContentBlockedError,
  ProviderAuthError,
  ProviderTimeoutError,
  QuotaExceededError,
  UserFacingError,
} from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import {
  CHAT_WITH_TOOLS,
  type ChatProvider,
  type ChatRequest,
  type ChatResponse,
  type ChatTurn,
  type ToolCall,
  type ToolDefinition,
} from './types.js';

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

interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

interface ChatCompletionResponse {
  choices?: {
    message?: {
      content?: string | null;
      tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[];
    };
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
  readonly capabilities = CHAT_WITH_TOOLS;

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
        body: JSON.stringify({
          model: request.model,
          messages: [
            { role: 'system', content: request.systemInstruction },
            ...request.history.map(toOpenAiMessage),
          ],
          max_tokens: request.maxOutputTokens,
          stream: false,
          ...(request.tools?.length ? { tools: request.tools.map(toOpenAiTool) } : {}),
        }),
        signal: controller.signal,
      });

      const payload = await this.readJson(response);

      if (!response.ok) {
        throw this.translateHttpError(response.status, payload);
      }

      const choice = payload.choices?.[0];
      const text = stripReasoning(choice?.message?.content ?? '');
      const toolCalls = readToolCalls(choice?.message?.tool_calls);

      // 模型決定先呼叫工具時，content 本來就會是空的 —— 那不是被擋下
      if (text.length === 0 && toolCalls.length === 0) {
        throw explainEmptyResponse(choice?.finish_reason);
      }

      return {
        text,
        tokensIn: payload.usage?.prompt_tokens ?? 0,
        tokensOut: payload.usage?.completion_tokens ?? 0,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
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
 * 注意：不送 messages[].name。Groq 收到這個欄位會直接回 400。
 * 說話者是用內文的 `[名字]` 前綴表示的（見 src/ai/context.ts）。
 */
function toOpenAiMessage(turn: ChatTurn): OpenAiMessage {
  if (turn.role === 'tool') {
    return { role: 'tool', tool_call_id: turn.toolCallId, content: turn.text };
  }

  if (turn.role === 'model') {
    const base: OpenAiMessage = {
      role: 'assistant',
      // 只呼叫工具、沒說話時 content 必須是 null 而不是空字串
      content: turn.text.length > 0 ? turn.text : null,
    };

    if (!turn.toolCalls?.length) return base;

    return {
      ...base,
      tool_calls: turn.toolCalls.map((call) => ({
        id: call.id,
        type: 'function' as const,
        function: { name: call.name, arguments: JSON.stringify(call.args) },
      })),
    };
  }

  return { role: 'user', content: turn.text };
}

function toOpenAiTool(tool: ToolDefinition) {
  return {
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

function readToolCalls(
  calls: { id?: string; function?: { name?: string; arguments?: string } }[] | undefined,
): ToolCall[] {
  if (!calls?.length) return [];

  const parsed: ToolCall[] = [];

  for (const [index, call] of calls.entries()) {
    const name = call.function?.name;
    if (!name) continue;

    parsed.push({
      id: call.id ?? `call_${index}`,
      name,
      // 模型產生的 arguments 是字串，內容不保證是合法 JSON，壞掉就當成沒有參數，
      // 讓工具自己的參數驗證去回報哪裡不對，而不是在這裡整個炸掉
      args: safeParseArgs(call.function?.arguments),
    });
  }

  return parsed;
}

function safeParseArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};

  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
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
