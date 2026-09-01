import { deployCommands } from '../bot/deployCommands.js';
import { loadDotEnvFile, loadEnv } from '../config/env.js';
import { logger } from '../utils/logger.js';

/** 手動註冊 slash command：npm run commands:deploy */
loadDotEnvFile();
const env = loadEnv();

await deployCommands({
  token: env.DISCORD_TOKEN,
  clientId: env.DISCORD_CLIENT_ID,
  devGuildId: env.DEV_GUILD_ID,
}).catch((error) => {
  logger.error('註冊指令失敗', error);
  process.exit(1);
});
