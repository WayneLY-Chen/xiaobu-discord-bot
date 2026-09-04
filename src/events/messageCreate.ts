import {
  AttachmentBuilder,
  ChannelType,
  Events,
  PermissionFlagsBits,
  type Client,
  type Message,
  type SendableChannels,
} from 'discord.js';
import type { ChatReply } from '../ai/chatService.js';
import type { BotContext } from '../bot/context.js';
import { resolveSettings } from '../config/resolveSettings.js';
import { ensureGuildSettings, getUserSettings } from '../database/repositories/settings.js';
import { listGuildTriggers, matchTrigger } from '../database/repositories/guildTriggers.js';
import { upsertGuild, upsertUser } from '../database/repositories/identity.js';
import { chunkMessage } from '../utils/messageChunk.js';
import { toUserMessage, UserFacingError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

/** Discord 的 typing 指示大約 10 秒後消失，所以要定期重送。 */
const TYPING_REFRESH_MS = 8_000;

/** 同一個伺服器兩次觸發台詞之間至少要隔這麼久。指令的說明文字也用這個數字。 */
export const TRIGGER_COOLDOWN_SECONDS = 60;
const TRIGGER_COOLDOWN_MS = TRIGGER_COOLDOWN_SECONDS * 1000;

/** guildId → 上次唸台詞的時間。 */
const lastTriggeredAt = new Map<string, number>();

/**
 * 正在唸台詞的伺服器。
 *
 * 刻意**不排隊**：VoiceSession.speak() 的佇列沒有上限，排隊等於讓任何人
 * 用十則純文字訊息預約十幾分鐘的語音，而且中途沒辦法取消。正在唸的時候
 * 直接丟掉新的觸發，比排起來誠實。
 */
const speakingTrigger = new Set<string>();

export function registerMessageCreate(client: Client, context: BotContext): void {
  client.on(Events.MessageCreate, (message) => {
    void handleMessage(message, context).catch((error) => {
      logger.error('處理訊息時發生未捕捉的錯誤', error);
    });
  });
}

async function handleMessage(message: Message, context: BotContext): Promise<void> {
  const botUser = message.client.user;

  // 忽略自己、其他 bot、系統訊息、私訊
  if (message.author.bot || message.system) return;
  if (!message.inGuild()) return;
  if (message.channel.type !== ChannelType.GuildText) return;

  const settings = loadSettings(message, context);
  if (!settings.chatEnabled) return;

  // 觸發台詞走自己的路：不需要 @ 小步、不需要在 AI 頻道、也不產生任何文字訊息。
  // 放在這裡是因為 loadSettings 每則訊息本來就會跑，多這一段不增加成本。
  maybeSpeakTrigger(message, context);

  const mentioned = message.mentions.users.has(botUser.id);
  const inAiChannel = settings.aiChannelId === message.channelId;
  if (!mentioned && !inAiChannel) return;

  if (!canSpeakIn(message)) return;

  const content = stripBotMention(message.content, botUser.id);
  if (content.length === 0) {
    await message.reply('有什麼需要幫忙的嗎？直接告訴我就好。');
    return;
  }

  const denial = context.rateLimiter.check(message.guildId, message.author.id);
  if (denial) {
    const seconds = Math.ceil(denial.retryAfterMs / 1000);
    const reason =
      denial.scope === 'user'
        ? `你問得有點快，請 ${seconds} 秒後再試。`
        : denial.scope === 'guild'
          ? `這個伺服器目前請求量偏高，請 ${seconds} 秒後再試。`
          : `Bot 目前整體負載偏高，請 ${seconds} 秒後再試。`;

    await message.reply(reason);
    return;
  }

  const stopTyping = startTyping(message.channel);

  try {
    const reply = await context.chat.reply(
      {
        guildId: message.guildId,
        guildName: message.guild.name,
        channelId: message.channelId,
        channelName: message.channel.name,
        userId: message.author.id,
        displayName: message.member?.displayName ?? message.author.displayName,
        content,
      },
      settings,
    );

    await sendChunked(message, reply);
  } catch (error) {
    if (!(error instanceof UserFacingError)) {
      logger.error('AI 回覆失敗', error);
    }
    await message.reply(toUserMessage(error));
  } finally {
    stopTyping();
  }
}

/**
 * 訊息命中觸發詞就在語音頻道唸出對應的台詞。
 *
 * 三道閘，缺一不可：
 * 1. 小步得正在這個伺服器的語音頻道裡（順便讓 99.9% 的訊息在查資料庫前就返回）
 * 2. **講話的人也得在同一個語音頻道裡** —— 少了這關，任何能在任一文字頻道
 *    打字的人都能把上百秒的音訊灌進一個他自己根本進不去的語音頻道
 * 3. 冷卻時間與「同時只准一段在飛」，避免有人用純文字訊息洗語音
 *
 * 刻意不 await：speak() 回傳的是整段播放完成的 Promise，await 它會把
 * 後面的 AI 文字回覆卡住整整一兩分鐘。
 */
function maybeSpeakTrigger(message: Message<true>, context: BotContext): void {
  const session = context.voice?.sessionFor(message.guildId);
  if (!session) return;

  if (message.member?.voice.channelId !== session.channelId) return;
  if (speakingTrigger.has(message.guildId)) return;
  if (Date.now() - (lastTriggeredAt.get(message.guildId) ?? 0) < TRIGGER_COOLDOWN_MS) return;

  const hit = matchTrigger(listGuildTriggers(context.db, message.guildId), message.content);
  if (!hit) return;

  lastTriggeredAt.set(message.guildId, Date.now());
  speakingTrigger.add(message.guildId);
  logger.info(`觸發台詞 #${hit.id}「${hit.phraseRaw}」（${message.guild.name}）`);

  void session.speak(hit.response).finally(() => speakingTrigger.delete(message.guildId));
}

/** 讀取這個 guild + user 實際生效的設定，順便把身分寫進本地資料庫。 */
function loadSettings(message: Message<true>, context: BotContext) {
  upsertGuild(context.db, message.guildId, message.guild.name);
  upsertUser(context.db, message.author.id, message.author.username);

  return resolveSettings(
    ensureGuildSettings(context.db, message.guildId),
    getUserSettings(context.db, message.author.id),
    { model: context.env.DEFAULT_MODEL, locale: 'zh-TW' },
  );
}

/** 沒有發言權限就安靜離開，不要留下一堆錯誤 log。 */
function canSpeakIn(message: Message<true>): boolean {
  const me = message.guild.members.me;
  if (!me) return false;

  const permissions = message.channel.permissionsFor(me);
  return (
    permissions?.has(PermissionFlagsBits.ViewChannel) === true &&
    permissions.has(PermissionFlagsBits.SendMessages)
  );
}

function stripBotMention(content: string, botId: string): string {
  return content.replaceAll(new RegExp(`<@!?${botId}>`, 'g'), ' ').trim();
}

/** 回傳一個停止函式；呼叫端一定要在 finally 裡執行，否則 interval 會外洩。 */
function startTyping(channel: SendableChannels): () => void {
  void channel.sendTyping().catch(() => undefined);
  const timer = setInterval(() => {
    void channel.sendTyping().catch(() => undefined);
  }, TYPING_REFRESH_MS);

  return () => clearInterval(timer);
}

/**
 * 第一段用 reply 讓對話有脈絡，後續段落直接 send，避免洗版式的連續提及。
 *
 * 圖片附在**最後一段**：Discord 會把附件顯示在該則訊息下方，
 * 掛在第一段的話文字被切開時圖會夾在中間，讀起來很怪。
 */
async function sendChunked(message: Message<true>, reply: ChatReply): Promise<void> {
  const files = reply.images.map((image) => new AttachmentBuilder(image.data, { name: image.filename }));
  const chunks = chunkMessage(reply.text);
  const first = chunks[0];

  if (first === undefined) {
    // 有圖但沒文字時仍然要把圖送出去，不能因為模型沒說話就把圖丟掉
    if (files.length > 0) {
      await message.reply({ files, allowedMentions: { repliedUser: true, parse: [] } });
      return;
    }

    await message.reply('我這次沒有產生出內容，換個說法再問一次看看。');
    return;
  }

  const rest = chunks.slice(1);

  await message.reply({
    content: first,
    ...(rest.length === 0 ? { files } : {}),
    allowedMentions: { repliedUser: true, parse: [] },
  });

  for (const [index, chunk] of rest.entries()) {
    await message.channel.send({
      content: chunk,
      ...(index === rest.length - 1 ? { files } : {}),
      allowedMentions: { parse: [] },
    });
  }
}
