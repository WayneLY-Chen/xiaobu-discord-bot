import { isAllowedModel, type AllowedModel } from './constants.js';
import type { GuildSettingsRow, UserSettingsRow } from '../database/schema.js';

export interface EffectiveSettings {
  model: AllowedModel;
  locale: string;
  personality: string | null;
  systemPrompt: string | null;
  chatEnabled: boolean;
  memoryEnabled: boolean;
  imageEnabled: boolean;
  voiceEnabled: boolean;
  aiChannelId: string | null;
}

export interface SettingsDefaults {
  model: AllowedModel;
  locale: string;
}

/**
 * 決定實際生效的設定。
 *
 * 優先順序：使用者個人偏好 > 伺服器設定 > 系統預設。
 * 例外是開關類（chatEnabled）：伺服器管理員關掉就是關掉，個人不能覆寫。
 * memoryEnabled 則是兩者都要開才算開 —— 管理員可以整個 server 關閉記憶，
 * 使用者也可以只關自己的。imageEnabled 與 voiceEnabled 只看伺服器設定，個人不能自己打開。
 *
 * model 會經過白名單驗證：資料庫裡可能存著已下架的 model 名稱，
 * 這時退回預設值而不是讓 API 呼叫失敗。
 */
export function resolveSettings(
  guild: GuildSettingsRow | undefined,
  user: UserSettingsRow | undefined,
  defaults: SettingsDefaults,
): EffectiveSettings {
  return {
    model: pickModel(user?.model, guild?.model, defaults.model),
    locale: user?.locale ?? guild?.locale ?? defaults.locale,
    personality: user?.personality ?? null,
    systemPrompt: guild?.systemPrompt ?? null,
    chatEnabled: guild?.chatEnabled ?? true,
    memoryEnabled: (guild?.memoryEnabled ?? true) && (user?.memoryEnabled ?? true),
    // 生圖預設關閉（schema 的 image_enabled 預設就是 false）：
    // 它比聊天貴、也比較容易被拿來亂玩，讓管理員自己決定要不要開。
    imageEnabled: guild?.imageEnabled ?? false,
    // 語音預設開啟：不像生圖會被拿來刷圖，要用它得先有人主動 /voice join。
    voiceEnabled: guild?.voiceEnabled ?? true,
    aiChannelId: guild?.aiChannelId ?? null,
  };
}

function pickModel(
  userModel: string | null | undefined,
  guildModel: string | null | undefined,
  fallback: AllowedModel,
): AllowedModel {
  for (const candidate of [userModel, guildModel]) {
    if (candidate && isAllowedModel(candidate)) return candidate;
  }
  return fallback;
}
