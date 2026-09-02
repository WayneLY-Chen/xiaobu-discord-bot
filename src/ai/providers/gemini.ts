import {
  FinishReason,
  GoogleGenAI,
  Type,
  type Content,
  type FunctionDeclaration,
  type Part,
  type Schema,
} from '@google/genai';
import {
  ContentBlockedError,
  ProviderAuthError,
  ProviderTimeoutError,
  QuotaExceededError,
  UserFacingError,
} from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import { isDegenerate } from './output.js';
import {
  CHAT_WITH_TOOLS,
  type ChatProvider,
  type ChatRequest,
  type ChatResponse,
  type ChatTurn,
  type ToolCall,
  type ToolDefinition,
  type ToolParameterSchema,
} from './types.js';

export class GeminiClient implements ChatProvider {
  readonly id = 'gemini' as const;
  readonly tier = 'free' as const;
  readonly capabilities = CHAT_WITH_TOOLS;

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
        contents: toContents(request.history),
        config: {
          systemInstruction: request.systemInstruction,
          maxOutputTokens: request.maxOutputTokens,
          abortSignal: controller.signal,
          ...(request.tools?.length
            ? { tools: [{ functionDeclarations: request.tools.map(toFunctionDeclaration) }] }
            : {}),
        },
      });

      const text = response.text?.trim() ?? '';
      const toolCalls = readToolCalls(response.candidates?.[0]?.content?.parts);

      // 模型決定先呼叫工具時，text 本來就會是空的 —— 那不是被擋下
      if (text.length === 0 && toolCalls.length === 0) {
        const finishReason = response.candidates?.[0]?.finishReason;

        // 3.x 的 thinking 可能把整個輸出預算花在思考上，一個字都還沒吐出來就被截斷。
        // 那是長度問題不是內容被擋 —— 必須讓 Router 有機會換手，
        // 因為 ContentBlockedError 會被 Router 當成「不該重試」直接往上拋。
        if (finishReason === FinishReason.MAX_TOKENS) {
          throw new UserFacingError(
            'AI 這次沒有產生出內容（推理佔滿了輸出長度），請再試一次或換一個模型。',
            'finishReason=MAX_TOKENS',
          );
        }

        throw new ContentBlockedError(`finishReason=${finishReason ?? 'unknown'}`);
      }

      // 陷入重複迴圈的回覆當成這家壞掉，讓 Router 有機會換手
      if (isDegenerate(text)) {
        logger.warn(`Gemini（${request.model}）產生重複迴圈，已捨棄這次回覆`);
        throw new UserFacingError('AI 這次的回覆不完整，請再試一次。', 'degenerate output');
      }

      return {
        text,
        tokensIn: response.usageMetadata?.promptTokenCount ?? 0,
        tokensOut: response.usageMetadata?.candidatesTokenCount ?? 0,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      };
    } catch (error) {
      throw translateGeminiError(error);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * 把內部的對話格式轉成 Gemini 的 Content。
 *
 * Gemini 沒有獨立的 tool 角色：工具結果是放在 user 角色的 functionResponse part 裡，
 * 這是 SDK 規定的形式，不是我們自己選的。
 */
function toContents(history: ChatTurn[]): Content[] {
  return history.map((turn): Content => {
    if (turn.role === 'tool') {
      return {
        role: 'user',
        parts: [
          { functionResponse: { name: turn.toolName, response: { result: turn.text } } },
        ],
      };
    }

    if (turn.role === 'model' && turn.toolCalls?.length) {
      // thoughtSignature 一定要原封不動帶回去：Gemini 3.x 少了它會回 400
      // INVALID_ARGUMENT，整個工具流程會直接失敗。
      const parts: Part[] = turn.toolCalls.map((call) => ({
        functionCall: { name: call.name, args: call.args },
        ...(call.signature ? { thoughtSignature: call.signature } : {}),
      }));

      // 模型有時會一邊說話一邊呼叫工具，有文字就一起帶上
      return {
        role: 'model',
        parts: turn.text.length > 0 ? [{ text: turn.text }, ...parts] : parts,
      };
    }

    return { role: turn.role, parts: [{ text: turn.text }] };
  });
}

function toFunctionDeclaration(tool: ToolDefinition): FunctionDeclaration {
  return {
    name: tool.name,
    description: tool.description,
    parameters: toGeminiSchema(tool.parameters),
  };
}

/** Gemini 的 Schema 用 OpenAPI 風格的大寫型別名稱，與 JSON Schema 的小寫不同。 */
function toGeminiSchema(schema: ToolParameterSchema): Schema {
  const properties: Record<string, Schema> = {};

  for (const [name, property] of Object.entries(schema.properties)) {
    properties[name] = {
      type:
        property.type === 'number'
          ? Type.NUMBER
          : property.type === 'boolean'
            ? Type.BOOLEAN
            : Type.STRING,
      description: property.description,
      ...(property.enum ? { enum: [...property.enum] } : {}),
    };
  }

  return { type: Type.OBJECT, properties, required: [...schema.required] };
}

/**
 * 從回應的 parts 讀出工具呼叫。
 *
 * 刻意走 parts 而不是方便的 `response.functionCalls`：thoughtSignature 掛在
 * **Part** 上而不是 FunctionCall 上，用 functionCalls 就拿不到，
 * 下一輪把歷史送回去時 Gemini 會回 400。
 *
 * Gemini 的 functionCall 也不一定帶 id，為了讓歷史格式與 OpenAI 相容端點一致
 *（Router 換手時兩邊看到的歷史才不會對不起來），沒有 id 就自己補一個。
 */
function readToolCalls(parts: Part[] | undefined): ToolCall[] {
  if (!parts?.length) return [];

  const calls: ToolCall[] = [];

  for (const part of parts) {
    const call = part.functionCall;
    if (!call?.name) continue;

    calls.push({
      id: call.id ?? `gemini_call_${calls.length}`,
      name: call.name,
      args: call.args ?? {},
      ...(part.thoughtSignature ? { signature: part.thoughtSignature } : {}),
    });
  }

  return calls;
}

/**
 * 把 SDK 的錯誤轉成使用者看得懂的錯誤。
 * 這裡只負責分類，換手到別的 provider 是 AiRouter 的事 ——
 * 而且 Router 絕不會自動切到付費服務（Planning §30）。
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
