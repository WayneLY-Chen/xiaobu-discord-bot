import type { Client, Guild } from 'discord.js';
import { logger } from '../utils/logger.js';

/**
 * 讓 Bot 在伺服器裡用「應用程式名稱」顯示。
 *
 * 為什麼需要這個：Discord 對 Bot 的「使用者名稱」有字元限制，中文名稱存不進去
 *（PATCH /users/@me 會回 200 但實際被還原），所以 Bot 帳號的 username 會停在
 * 建立時自動產生的 botXXXXXXXX。伺服器內的暱稱沒有這個限制，因此加入伺服器時
 * 主動把暱稱設成應用程式名稱，使用者看到的就會是正確的名字。
 *
 * 需要 Change Nickname 權限（@everyone 預設就有）。沒有權限就靜默略過，
 * 這只是顯示問題，不該影響 Bot 運作。
 */
export async function applyBotNickname(guild: Guild, name: string): Promise<void> {
  const me = guild.members.me;
  if (!me || me.nickname === name) return;

  try {
    await me.setNickname(name, '同步 Bot 顯示名稱');
    logger.info(`已在「${guild.name}」把暱稱設為 ${name}`);
  } catch (error) {
    logger.debug(
      `無法在「${guild.name}」設定暱稱（多半是缺少 Change Nickname 權限）：` +
        (error instanceof Error ? error.message : String(error)),
    );
  }
}

/**
 * 取得要顯示的名稱。
 * 優先用應用程式名稱（管理員在 Developer Portal 設定的），取不到才退回帳號名稱。
 */
export async function resolveBotName(client: Client<true>): Promise<string> {
  try {
    const application = await client.application.fetch();
    if (application.name) return application.name;
  } catch (error) {
    logger.debug(
      '無法取得應用程式名稱：' + (error instanceof Error ? error.message : String(error)),
    );
  }

  return client.user.displayName;
}
