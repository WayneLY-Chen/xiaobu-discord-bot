import { isAllowedModel, type AllowedModel } from './constants.js';
import type { GuildSettingsRow, UserSettingsRow } from '../database/schema.js';

export interface EffectiveSettings {
  model: AllowedModel;
  locale: string;
  personality: string | null;
  systemPrompt: string | null;
  chatEnabled: boolean;
  memoryEnabled: boolean;
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
 * 使用者也可以只關自己的。
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
