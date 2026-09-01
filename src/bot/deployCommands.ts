import { REST, Routes } from 'discord.js';
import { toCommandJSON } from '../commands/index.js';
import { logger } from '../utils/logger.js';

export interface DeployOptions {
  token: string;
  clientId: string;
  /** 設定時註冊為該 guild 的指令（立即生效，適合開發）；未設定則註冊為全域指令。 */
  devGuildId?: string | undefined;
}

/**
 * 註冊 slash command。
 *
 * 全域指令 Discord 端可能需要最多一小時才會全部生效，這是 Discord 的限制，
 * 不是 Bot 的問題。開發時設定 DEV_GUILD_ID 就能立即看到指令。
 */
export async function deployCommands(options: DeployOptions): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(options.token);
  const body = toCommandJSON();

  try {
    if (options.devGuildId) {
      await rest.put(Routes.applicationGuildCommands(options.clientId, options.devGuildId), {
        body,
      });
      logger.info(`已註冊 ${body.length} 個指令到開發伺服器 ${options.devGuildId}`);
      return;
    }

    await rest.put(Routes.applicationCommands(options.clientId), { body });
    logger.info(`已註冊 ${body.length} 個全域指令（最多可能需要 1 小時生效）`);
  } catch (error) {
    throw new Error(explainDeployFailure(error, options), { cause: error });
  }
}

/** Discord 的原始錯誤訊息（例如 "Missing Access"）看不出要修什麼，這裡翻譯成可行動的指示。 */
function explainDeployFailure(error: unknown, options: DeployOptions): string {
  const message = error instanceof Error ? error.message : String(error);

  if (/Missing Access|Unknown Guild|50001|10004/i.test(message)) {
    return options.devGuildId
      ? `無法把指令註冊到伺服器 ${options.devGuildId}。常見原因：` +
          '(1) Bot 還沒被邀請進這個伺服器；' +
          '(2) 邀請時沒有勾選 applications.commands scope；' +
          '(3) DEV_GUILD_ID 填錯（要填伺服器 ID，不是頻道 ID）。' +
          '請用 README 的邀請連結重新邀請一次。'
      : '註冊全域指令被拒絕，請確認 DISCORD_CLIENT_ID 與 DISCORD_TOKEN 屬於同一個 Application。';
  }

  if (/401|Unauthorized|invalid token/i.test(message)) {
    return 'DISCORD_TOKEN 無效，請到 Developer Portal 重新 Reset Token。';
  }

  return `註冊指令失敗：${message}`;
}
