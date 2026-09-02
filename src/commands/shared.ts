import type { AiRouter } from '../ai/router.js';
import { getModelSpec, MODEL_CATALOG, PROVIDER_LABEL } from '../config/constants.js';

/** 選單裡代表「不覆寫，沿用上一層設定」的特殊值。 */
export const INHERIT = '__inherit__';

/**
 * 選單刻意列出整份白名單，而不是只列「目前有 Key 的 provider」。
 *
 * 因為 slash command 的定義是啟動時註冊到 Discord 的，如果內容跟著 API Key 變動，
 * 管理員每加一把 Key 就得重新註冊指令、還要等 Discord 傳播。
 * 改成選到沒設定的 provider 時，在執行階段給明確訊息（見 explainUnavailableModel）。
 */
export const MODEL_CHOICES = [
  { name: '使用預設（沿用上一層設定）', value: INHERIT },
  ...MODEL_CATALOG.map((model) => ({ name: model.label, value: model.id })),
];

export const LOCALE_CHOICES = [
  { name: '使用預設', value: INHERIT },
  { name: '繁體中文', value: 'zh-TW' },
  { name: 'English', value: 'en-US' },
  { name: '日本語', value: 'ja-JP' },
];

/**
 * 選到的模型如果屬於沒設定 API Key 的 provider，回傳要顯示的說明；可用則回傳 null。
 * 讓使用者知道是「Bot 沒接這家」而不是「你選錯了」。
 */
export function explainUnavailableModel(modelId: string, router: AiRouter): string | null {
  const spec = getModelSpec(modelId);
  if (!spec || router.isConfigured(spec.provider)) return null;

  const usable = MODEL_CATALOG.filter((model) => router.isConfigured(model.provider))
    .map((model) => model.id)
    .join('、');

  return (
    `**${modelId}** 需要 ${PROVIDER_LABEL[spec.provider]} 的 API Key，Bot 管理員還沒設定，所以選了也用不了。\n` +
    (usable.length > 0 ? `目前可用的模型：${usable}` : '目前沒有任何可用的模型，請通知 Bot 管理員。')
  );
}

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
