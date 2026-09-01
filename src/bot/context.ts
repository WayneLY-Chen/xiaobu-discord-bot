import type { ChatInputCommandInteraction, SlashCommandOptionsOnlyBuilder, SlashCommandSubcommandsOnlyBuilder } from 'discord.js';
import type { SlashCommandBuilder } from 'discord.js';
import type { Env } from '../config/env.js';
import type { Db } from '../database/client.js';
import type { ChatService } from '../ai/chatService.js';
import type { TieredRateLimiter } from '../utils/rateLimiter.js';

/** 所有 handler 共用的相依物件，用參數傳遞而不是 global，方便測試。 */
export interface BotContext {
  env: Env;
  db: Db;
  chat: ChatService;
  rateLimiter: TieredRateLimiter;
}

export type CommandData =
  | SlashCommandBuilder
  | SlashCommandOptionsOnlyBuilder
  | SlashCommandSubcommandsOnlyBuilder;

export interface Command {
  data: CommandData;
  execute(interaction: ChatInputCommandInteraction, context: BotContext): Promise<void>;
}
