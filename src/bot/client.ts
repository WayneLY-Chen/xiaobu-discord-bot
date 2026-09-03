import { Client, GatewayIntentBits, Options, Partials } from 'discord.js';

/**
 * 建立 Discord Client。
 *
 * MessageContent 是 privileged intent：必須先到 Discord Developer Portal
 * 開啟「Message Content Intent」，否則 Bot 讀不到訊息內容（詳見 README）。
 *
 * cache 設定是為了正式機的 **954MB** RAM（Oracle Always Free）—— 預設會快取大量
 * 成員資料，加入很多 server 之後記憶體會失控，這裡只留必要的。
 */
export function createClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      // 語音功能必需。少了它 member.voice.channel 永遠是 null，
      // /voice join 會一直說「你要先進語音頻道」，而且完全不留錯誤記錄。
      // 這不是 privileged intent，不需要去 Developer Portal 開任何開關。
      GatewayIntentBits.GuildVoiceStates,
    ],
    partials: [Partials.Channel],
    makeCache: Options.cacheWithLimits({
      ...Options.DefaultMakeCacheSettings,
      MessageManager: 50,
      GuildMemberManager: { maxSize: 200, keepOverLimit: (member) => member.id === member.client.user.id },
      PresenceManager: 0,
      ReactionManager: 0,
      GuildStickerManager: 0,
      GuildScheduledEventManager: 0,
    }),
  });
}
