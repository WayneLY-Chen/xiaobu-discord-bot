import type { ProviderId } from '../../config/constants.js';

/** 送進模型的一輪對話。沿用 Gemini 的命名，'model' 表示 AI 那一方。 */
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

/**
 * 這個 provider **實際實作了**哪些能力。
 *
 * 規格 §9 要求「根據 Provider 真實 API 能力」，但這裡刻意描述的是
 * 「本專案已經實作並測過的能力」，不是「這家 API 理論上做得到什麼」。
 * 例如 Gemini API 支援 vision，但 Phase 2 還沒接，所以 vision 仍然是 false。
 * 等 Phase 4 / Phase 6 實作了再改成 true，避免 Router 依賴不存在的功能。
 */
export interface ProviderCapabilities {
  chat: boolean;
  vision: boolean;
  image: boolean;
  audio: boolean;
}

export const CHAT_ONLY: ProviderCapabilities = {
  chat: true,
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
