import { GatewayIntentBits } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { createClient } from '../src/bot/client.js';

describe('Discord Client 設定', () => {
  it('帶著語音功能必需的 GuildVoiceStates intent', () => {
    const client = createClient();

    // 少了這個 intent，member.voice.channel 永遠是 null：/voice join 會一直
    // 回「你要先進語音頻道」，而且那條路徑不寫記錄，查起來完全沒有線索。
    // 實際踩過一次，所以在這裡釘住。
    expect(client.options.intents.has(GatewayIntentBits.GuildVoiceStates)).toBe(true);
  });

  it('帶著讀取訊息內容必需的 intent', () => {
    const client = createClient();

    expect(client.options.intents.has(GatewayIntentBits.Guilds)).toBe(true);
    expect(client.options.intents.has(GatewayIntentBits.GuildMessages)).toBe(true);
    expect(client.options.intents.has(GatewayIntentBits.MessageContent)).toBe(true);
  });
});
