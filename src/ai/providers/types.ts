import type { ProviderId } from '../../config/constants.js';

/**
 * 工具參數的 schema。
 *
 * 這是 JSON Schema 的子集 —— 只保留描述工具參數真正需要的部分。
 * 刻意不做成完整的 JSON Schema：Gemini 與 OpenAI 相容端點對 schema 的支援度
 * 不完全一樣，限制在這個子集內兩邊都吃得下，也讓 input validation 好寫。
 */
export interface ToolParameterSchema {
  type: 'object';
  properties: Record<
    string,
    {
      type: 'string' | 'number' | 'boolean';
      description: string;
      enum?: readonly string[];
    }
  >;
  required: readonly string[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolParameterSchema;
}

/** 模型要求呼叫某個工具。 */
export interface ToolCall {
  /**
   * OpenAI 相容端點用 id 把結果對回呼叫；Gemini 沒有這個概念。
   * 為了讓兩邊的歷史格式一致（換手時才不會壞），Gemini 那邊會自己合成 id。
   */
  id: string;
  name: string;
  args: Record<string, unknown>;
  /**
   * Provider 專屬的不透明簽章，原封不動帶回去就對了。
   *
   * Gemini 3.x 要求把工具呼叫寫回歷史時附上當初的 thought_signature，
   * 少了它會直接回 400 INVALID_ARGUMENT。OpenAI 相容端點沒有這個東西，
   * 會忽略這個欄位。
   */
  signature?: string;
}

/** 送進模型的一輪對話。沿用 Gemini 的命名，'model' 表示 AI 那一方。 */
export type ChatTurn =
  | { role: 'user'; text: string }
  | { role: 'model'; text: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; toolName: string; text: string };

export interface ChatRequest {
  model: string;
  systemInstruction: string;
  history: ChatTurn[];
  maxOutputTokens: number;
  timeoutMs: number;
  /** 提供給模型的工具。不給就是純聊天。 */
  tools?: ToolDefinition[];
}

export interface ChatResponse {
  text: string;
  tokensIn: number;
  tokensOut: number;
  /** 模型決定要先呼叫工具而不是直接回答。 */
  toolCalls?: ToolCall[];
}

/**
 * 這個 provider **實際實作了**哪些能力。
 *
 * 規格 §9 要求「根據 Provider 真實 API 能力」，但這裡刻意描述的是
 * 「本專案已經實作並測過的能力」，不是「這家 API 理論上做得到什麼」。
 * 例如 Gemini API 支援 vision，但還沒接，所以 vision 仍然是 false。
 * 等 Phase 4 / Phase 6 實作了再改成 true，避免 Router 依賴不存在的功能。
 */
export interface ProviderCapabilities {
  chat: boolean;
  tools: boolean;
  vision: boolean;
  image: boolean;
  audio: boolean;
}

export const CHAT_ONLY: ProviderCapabilities = {
  chat: true,
  tools: false,
  vision: false,
  image: false,
  audio: false,
};

export const CHAT_WITH_TOOLS: ProviderCapabilities = {
  chat: true,
  tools: true,
  vision: false,
  image: false,
  audio: false,
};

export interface ChatProvider {
  readonly id: ProviderId;
  /**
   * free：免費額度內可用。
   * paid：會產生費用 —— Router 只有在 ALLOW_PAID_PROVIDERS=true 時才會碰。
   */
  readonly tier: 'free' | 'paid';
  readonly capabilities: ProviderCapabilities;
  chat(request: ChatRequest): Promise<ChatResponse>;
}
