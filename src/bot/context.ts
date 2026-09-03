import type { ChatInputCommandInteraction, SlashCommandOptionsOnlyBuilder, SlashCommandSubcommandsOnlyBuilder } from 'discord.js';
import type { SlashCommandBuilder } from 'discord.js';
import type { Env } from '../config/env.js';
import type { Db } from '../database/client.js';
import type { ChatService } from '../ai/chatService.js';
import type { AiRouter } from '../ai/router.js';
import type { TieredRateLimiter } from '../utils/rateLimiter.js';
import type { VoiceManager } from '../voice/manager.js';

/** 所有 handler 共用的相依物件，用參數傳遞而不是 global，方便測試。 */
export interface BotContext {
  env: Env;
  db: Db;
  chat: ChatService;
  /** 指令需要知道哪些 provider 真的可用，才能擋掉選不到的模型。 */
  router: AiRouter;
  rateLimiter: TieredRateLimiter;
  /** 語音功能。找不到 Piper 的模型檔案時是 undefined，指令會據此回覆「未啟用」。 */
  voice?: VoiceManager;
}

export type CommandData =
  | SlashCommandBuilder
  | SlashCommandOptionsOnlyBuilder
  | SlashCommandSubcommandsOnlyBuilder;

export interface Command {
  data: CommandData;
  execute(interaction: ChatInputCommandInteraction, context: BotContext): Promise<void>;
}
