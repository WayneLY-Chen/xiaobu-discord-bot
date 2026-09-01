/**
 * Phase 1 只支援 Gemini。允許的 model 白名單，避免使用者填入不存在或付費專屬的 model。
 *
 * 名單內每一個在 Gemini API Free Tier 都標示 Free of charge（2026-09 查證，見 README）。
 * 由省額度到耗額度排序：flash-lite 的免費額度比 flash 寬鬆，所以放前面。
 * gemini-2.5-pro 未出現在免費清單中，依規格「不確定就不假設免費」不納入。
 */
export const ALLOWED_MODELS = [
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash-lite',
  'gemini-2.5-flash-lite',
  'gemini-3.5-flash',
  'gemini-3.6-flash',
  'gemini-3.7-flash',
  'gemini-2.5-flash',
] as const;

export type AllowedModel = (typeof ALLOWED_MODELS)[number];

export function isAllowedModel(value: string): value is AllowedModel {
  return (ALLOWED_MODELS as readonly string[]).includes(value);
}

export const SUPPORTED_LOCALES = ['zh-TW', 'en-US', 'ja-JP'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

/** Discord 單則訊息上限 2000 字元，留一點餘裕給續行標記。 */
export const DISCORD_MESSAGE_LIMIT = 1900;

/** 使用者自訂 personality / system prompt 的長度上限。 */
export const MAX_PERSONALITY_LENGTH = 500;
export const MAX_SYSTEM_PROMPT_LENGTH = 1000;
