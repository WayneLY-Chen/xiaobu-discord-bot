/** 目前接上的 AI provider。新增 provider 時這裡與 src/ai/providers/ 一起加。 */
export const PROVIDER_IDS = ['gemini', 'groq'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export interface ModelSpec {
  /** 送給 provider API 的 model id，同時也是使用者在 /settings model 選到的值。 */
  readonly id: string;
  readonly provider: ProviderId;
  /** Discord 選單顯示的名稱。 */
  readonly label: string;
  /**
   * production：provider 官方標示可用於正式環境。
   * preview：官方標示「僅供評估」，可能隨時下架 —— 選單會標註，也不會被當成 fallback 預設。
   */
  readonly stability: 'production' | 'preview';
}

/**
 * 允許使用的 model 白名單。
 *
 * 名單內每一個都在該 provider 的免費層可用（2026-09 查證，來源見 README）。
 * 依規格 §11「不確定就不假設免費」，沒有明確列為免費的一律不納入
 * （例如 gemini-2.5-pro 未出現在 Gemini 免費清單中）。
 *
 * Gemini 由省額度到耗額度排序：flash-lite 的免費額度比 flash 寬鬆，所以放前面。
 */
export const MODEL_CATALOG = [
  // --- Gemini（Free Tier 標示 Free of charge）---
  { id: 'gemini-3.1-flash-lite', provider: 'gemini', label: 'Gemini 3.1 Flash-Lite', stability: 'production' },
  { id: 'gemini-3.5-flash-lite', provider: 'gemini', label: 'Gemini 3.5 Flash-Lite', stability: 'production' },
  { id: 'gemini-2.5-flash-lite', provider: 'gemini', label: 'Gemini 2.5 Flash-Lite', stability: 'production' },
  { id: 'gemini-3.5-flash', provider: 'gemini', label: 'Gemini 3.5 Flash', stability: 'production' },
  { id: 'gemini-3.6-flash', provider: 'gemini', label: 'Gemini 3.6 Flash', stability: 'production' },
  { id: 'gemini-3.7-flash', provider: 'gemini', label: 'Gemini 3.7 Flash', stability: 'production' },
  { id: 'gemini-2.5-flash', provider: 'gemini', label: 'Gemini 2.5 Flash', stability: 'production' },

  // --- Groq（免費層 30 RPM / 1000 RPD / 200K TPD）---
  { id: 'llama-3.3-70b-versatile', provider: 'groq', label: 'Groq Llama 3.3 70B', stability: 'production' },
  { id: 'llama-3.1-8b-instant', provider: 'groq', label: 'Groq Llama 3.1 8B（最快）', stability: 'production' },
  { id: 'openai/gpt-oss-120b', provider: 'groq', label: 'Groq GPT-OSS 120B', stability: 'production' },
  { id: 'openai/gpt-oss-20b', provider: 'groq', label: 'Groq GPT-OSS 20B', stability: 'production' },

  // Groq 官方把 Qwen 標為 preview（intended for evaluation purposes only），
  // 可能隨時下架，所以不當預設、也不當 fallback 目標，只讓想用的人自己選。
  { id: 'qwen/qwen3.6-27b', provider: 'groq', label: 'Groq Qwen3.6 27B（preview，可能下架）', stability: 'preview' },
  { id: 'qwen/qwen3.8-27b', provider: 'groq', label: 'Groq Qwen3.8 27B（preview，可能下架）', stability: 'preview' },
] as const satisfies readonly ModelSpec[];

export type AllowedModel = (typeof MODEL_CATALOG)[number]['id'];

/** z.enum 需要 tuple 型別，所以這裡標註成非空 tuple。 */
export const ALLOWED_MODELS = MODEL_CATALOG.map((model) => model.id) as [
  AllowedModel,
  ...AllowedModel[],
];

const MODELS_BY_ID = new Map<string, ModelSpec>(MODEL_CATALOG.map((model) => [model.id, model]));

export function isAllowedModel(value: string): value is AllowedModel {
  return MODELS_BY_ID.has(value);
}

export function getModelSpec(id: string): ModelSpec | undefined {
  return MODELS_BY_ID.get(id);
}

/**
 * 每個 provider 的預設 model。
 *
 * Router 換手到別的 provider 時用這個，所以一律選 production 標記的模型 ——
 * fallback 是救命用的，不能指望一個隨時可能下架的 preview 模型。
 */
export const PROVIDER_DEFAULT_MODEL = {
  gemini: 'gemini-3.1-flash-lite',
  groq: 'llama-3.3-70b-versatile',
} as const satisfies Record<ProviderId, AllowedModel>;

/** 給錯誤訊息用的中文名稱。 */
export const PROVIDER_LABEL = {
  gemini: 'Gemini',
  groq: 'Groq',
} as const satisfies Record<ProviderId, string>;

export const SUPPORTED_LOCALES = ['zh-TW', 'en-US', 'ja-JP'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

/** Discord 單則訊息上限 2000 字元，留一點餘裕給續行標記。 */
export const DISCORD_MESSAGE_LIMIT = 1900;

/** 使用者自訂 personality / system prompt 的長度上限。 */
export const MAX_PERSONALITY_LENGTH = 500;
export const MAX_SYSTEM_PROMPT_LENGTH = 1000;
