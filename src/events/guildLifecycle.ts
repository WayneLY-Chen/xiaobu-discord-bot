import { Events, type Client } from 'discord.js';
import type { BotContext } from '../bot/context.js';
import { markGuildInactive, upsertGuild } from '../database/repositories/identity.js';
import { ensureGuildSettings } from '../database/repositories/settings.js';
import { logger } from '../utils/logger.js';
import { applyBotNickname, resolveBotName } from '../bot/nickname.js';

/**
 * 加入 / 離開伺服器時維護 guild 紀錄。
 * 被踢出時只標記為 inactive，不刪資料 —— 重新邀請後設定還在。
 */
export function registerGuildLifecycle(client: Client, context: BotContext): void {
  client.on(Events.GuildCreate, (guild) => {
    upsertGuild(context.db, guild.id, guild.name);
    ensureGuildSettings(context.db, guild.id);
    logger.info(`加入伺服器：${guild.name}（${guild.id}），成員約 ${guild.memberCount} 人`);

    // Discord 不接受中文的 Bot 使用者名稱，所以改用伺服器暱稱顯示正確名字
    void (async () => {
      if (!guild.client.isReady()) return;
      await applyBotNickname(guild, await resolveBotName(guild.client));
    })().catch(() => undefined);
  });

  client.on(Events.GuildDelete, (guild) => {
    markGuildInactive(context.db, guild.id);
    logger.info(`離開伺服器：${guild.name}（${guild.id}）`);
  });
}
