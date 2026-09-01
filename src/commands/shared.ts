import { ALLOWED_MODELS } from '../config/constants.js';

/** 選單裡代表「不覆寫，沿用上一層設定」的特殊值。 */
export const INHERIT = '__inherit__';

export const MODEL_CHOICES = [
  { name: '使用預設（沿用上一層設定）', value: INHERIT },
  ...ALLOWED_MODELS.map((model) => ({ name: model, value: model })),
];

export const LOCALE_CHOICES = [
  { name: '使用預設', value: INHERIT },
  { name: '繁體中文', value: 'zh-TW' },
  { name: 'English', value: 'en-US' },
  { name: '日本語', value: 'ja-JP' },
];

/** 把選單值轉成要寫進資料庫的值：INHERIT 代表清空覆寫。 */
export function toStoredValue(choice: string): string | null {
  return choice === INHERIT ? null : choice;
}

export function describe(value: string | null | undefined, fallback: string): string {
  return value ?? fallback;
}

export function onOff(value: boolean): string {
  return value ? '開啟' : '關閉';
}
