import { Events } from 'discord.js';
import { ChatService } from './ai/chatService.js';
import { createProviders } from './ai/providers/registry.js';
import { AiRouter } from './ai/router.js';
import { createImageRouter } from './ai/image/registry.js';
import { createSearchRouter } from './ai/search/registry.js';
import { createClient } from './bot/client.js';
import type { BotContext } from './bot/context.js';
import { deployCommands } from './bot/deployCommands.js';
import { startHealthServer } from './bot/healthServer.js';
import { applyBotNickname, resolveBotName } from './bot/nickname.js';
import { loadDotEnvFile, loadEnv } from './config/env.js';
import { closeDatabase, initDatabase } from './database/client.js';
import { upsertGuild } from './database/repositories/identity.js';
import { ensureGuildSettings } from './database/repositories/settings.js';
import { registerGuildLifecycle } from './events/guildLifecycle.js';
import { registerInteractionCreate } from './events/interactionCreate.js';
import { registerMessageCreate } from './events/messageCreate.js';
import { logger, setLogLevel } from './utils/logger.js';
import { TieredRateLimiter } from './utils/rateLimiter.js';
import { createTtsRouter } from './voice/registry.js';
import { VoiceManager } from './voice/manager.js';
import { GroqWhisperStt } from './voice/stt.js';
import { resolveSettings } from './config/resolveSettings.js';
import { getUserSettings } from './database/repositories/settings.js';
import { upsertUser } from './database/repositories/identity.js';

/** 定期清掉 rate limiter 裡過期的 key，避免長時間執行後記憶體堆積。 */
const RATE_LIMIT_PRUNE_INTERVAL_MS = 5 * 60 * 1000;

async function main(): Promise<void> {
  loadDotEnvFile();
  const env = loadEnv();
  setLogLevel(env.LOG_LEVEL);

  if (env.ALLOW_PAID_PROVIDERS) {
    logger.warn('ALLOW_PAID_PROVIDERS=true：已允許付費 provider。目前尚未接任何付費服務。');
  }

  const db = initDatabase(env.DATABASE_PATH);
  const router = new AiRouter(createProviders(env), {
    allowPaidProviders: env.ALLOW_PAID_PROVIDERS,
    fallbackEnabled: env.AI_FALLBACK_ENABLED,
  });

  if (env.AI_FALLBACK_ENABLED && router.availableProviders.length < 2) {
    logger.warn('只設定了一個 AI provider，額度用完時沒有其他免費服務可以接手。');
  }

  const search = createSearchRouter(env);
  const image = createImageRouter(env);
  const client = createClient();

  const context: BotContext = {
    env,
    db,
    rateLimiter: new TieredRateLimiter({
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      userLimit: env.RATE_LIMIT_USER,
      guildLimit: env.RATE_LIMIT_GUILD,
      globalLimit: env.RATE_LIMIT_GLOBAL,
    }),
    router,
    chat: new ChatService(
      db,
      router,
      search,
      image,
      // 生圖與聊天分開限流：一次生圖比一次聊天貴得多，額度也給得比較緊
      new TieredRateLimiter({
        windowMs: env.RATE_LIMIT_WINDOW_MS,
        userLimit: env.IMAGE_RATE_LIMIT_USER,
        guildLimit: env.IMAGE_RATE_LIMIT_GUILD,
        globalLimit: env.IMAGE_RATE_LIMIT_GLOBAL,
      }),
      {
        botName: 'AI Bot',
        contextMessageLimit: env.CONTEXT_MESSAGE_LIMIT,
        maxInputLength: env.MAX_INPUT_LENGTH,
        maxOutputTokens: env.AI_MAX_OUTPUT_TOKENS,
        timeoutMs: env.AI_TIMEOUT_MS,
        toolTimeoutMs: env.TOOL_TIMEOUT_MS,
        imageTimeoutMs: env.IMAGE_TIMEOUT_MS,
        timezone: env.TZ,
      },
    ),
  };

  // 語音需要三個條件同時成立：Piper 模型在、Groq key 有設定（Whisper 用它）、
  // 而且真的建得起來。少一個就整個關閉，文字聊天完全不受影響。
  context.voice = await createVoiceManager();

  registerMessageCreate(client, context);
  registerInteractionCreate(client, context);
  registerGuildLifecycle(client, context);

  client.once(Events.ClientReady, (readyClient) => {
    void (async () => {
      // 用應用程式名稱取代預設值，讓 system prompt 自稱正確
      const botName = await resolveBotName(readyClient);
      context.chat.setBotName(botName);

      // 補寫啟動時已經在裡面的伺服器（例如 Bot 離線期間被邀請）
      for (const guild of readyClient.guilds.cache.values()) {
        upsertGuild(db, guild.id, guild.name);
        ensureGuildSettings(db, guild.id);
        await applyBotNickname(guild, botName);
      }

      logger.info(
        `已登入為 ${readyClient.user.tag}（顯示名稱 ${botName}），` +
          `目前在 ${readyClient.guilds.cache.size} 個伺服器`,
      );
    })().catch((error) => logger.error('啟動後初始化失敗', error));
  });

  /**
   * 語音的 AI 回覆走的是與文字完全相同的 ChatService ——
   * 記憶、工具、伺服器設定、用量統計全部共用，不另外開一套。
   * 對話串用**語音頻道的 ID**，所以語音的上下文與文字頻道是分開的。
   */
  async function createVoiceManager(): Promise<VoiceManager | undefined> {
    if (!env.GROQ_API_KEY) {
      logger.warn('沒有設定 GROQ_API_KEY（語音辨識需要），語音功能停用。');
      return undefined;
    }

    const tts = await createTtsRouter(env);
    if ((await tts.ready()).length === 0) return undefined;

    return new VoiceManager(
      {
        tts,
        stt: new GroqWhisperStt(env.GROQ_API_KEY),
        ttsTimeoutMs: env.TTS_TIMEOUT_MS,
        sttTimeoutMs: env.STT_TIMEOUT_MS,
        silenceMs: env.VOICE_SILENCE_MS,
        maxUtteranceMs: env.VOICE_MAX_UTTERANCE_MS,
        respond: async (where, text) => {
          const guild = client.guilds.cache.get(where.guildId);
          const channel = guild?.channels.cache.get(where.channelId);
          if (!guild || !channel) return '';

          const member = await guild.members.fetch(where.userId).catch(() => null);
          const displayName = member?.displayName ?? '某位使用者';

          upsertGuild(db, guild.id, guild.name);
          upsertUser(db, where.userId, member?.user.username ?? where.userId);

          const settings = resolveSettings(
            ensureGuildSettings(db, guild.id),
            getUserSettings(db, where.userId),
            { model: env.DEFAULT_MODEL, locale: 'zh-TW' },
          );

          if (!settings.chatEnabled) return '';

          const denial = context.rateLimiter.check(guild.id, where.userId);
          if (denial) return '你講太快了，讓我喘口氣。';

          const reply = await context.chat.reply(
            {
              guildId: guild.id,
              guildName: guild.name,
              channelId: where.channelId,
              channelName: channel.name,
              userId: where.userId,
              displayName,
              content: text,
            },
            settings,
          );

          // 語音只唸模型講的話 —— 來源清單與換手提示在語音裡唸出來很吵，
          // 而且網址根本聽不懂
          return stripForSpeech(reply.text);
        },
      },
      env.VOICE_MAX_SESSIONS,
    );
  }

  client.on(Events.Error, (error) => logger.error('Discord client 錯誤', error));
  client.on(Events.Warn, (message) => logger.warn(`Discord client 警告：${message}`));

  const healthServer = startHealthServer(client, env.HEALTH_PORT);
  const pruneTimer = setInterval(
    () => context.rateLimiter.prune(),
    RATE_LIMIT_PRUNE_INTERVAL_MS,
  );

  // 指令註冊失敗不該讓整個 Bot 起不來：聊天功能（@Bot）不依賴 slash command，
  // 先讓 Bot 上線，把問題當成警告印出來就好。
  if (env.DEPLOY_COMMANDS_ON_START) {
    try {
      await deployCommands({
        token: env.DISCORD_TOKEN,
        clientId: env.DISCORD_CLIENT_ID,
        devGuildId: env.DEV_GUILD_ID,
      });
    } catch (error) {
      logger.warn(error instanceof Error ? error.message : String(error));
      logger.warn('Slash 指令暫時無法使用，但聊天功能不受影響。');
    }
  }

  await client.login(env.DISCORD_TOKEN);

  // Docker stop 會送 SIGTERM，要在這裡收乾淨，SQLite 才不會留下未 checkpoint 的 WAL
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info(`收到 ${signal}，準備關閉…`);
    clearInterval(pruneTimer);
    // 語音連線與底下的 piper / ffmpeg 子行程要先收掉，
    // 否則 client 斷線後它們會變成孤兒行程繼續佔記憶體
    context.voice?.destroyAll();
    healthServer.close();
    await client.destroy();
    closeDatabase();
    logger.info('已安全關閉。');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error) => {
  logger.error('啟動失敗', error instanceof Error ? error.message : error);
  process.exit(1);
});

/**
 * 把只適合用看的東西拿掉再唸出來：來源清單裡的網址唸出來沒有意義，
 * 換手提示也只是噪音。兩者都是附加在模型回覆後面的，切掉即可。
 */
function stripForSpeech(text: string): string {
  const sourceAt = text.indexOf('**來源**');
  const trimmed = sourceAt >= 0 ? text.slice(0, sourceAt) : text;

  const noticeAt = trimmed.indexOf('-# ⚠️');
  return (noticeAt >= 0 ? trimmed.slice(0, noticeAt) : trimmed).trim();
}
