import { Events, MessageFlags, type Client, type Interaction } from 'discord.js';
import type { BotContext } from '../bot/context.js';
import { commandsByName } from '../commands/index.js';
import { upsertGuild, upsertUser } from '../database/repositories/identity.js';
import { toUserMessage, UserFacingError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

export function registerInteractionCreate(client: Client, context: BotContext): void {
  client.on(Events.InteractionCreate, (interaction) => {
    void handleInteraction(interaction, context).catch((error) => {
      logger.error('處理指令時發生未捕捉的錯誤', error);
    });
  });
}

async function handleInteraction(interaction: Interaction, context: BotContext): Promise<void> {
  if (!interaction.isChatInputCommand()) return;

  const command = commandsByName.get(interaction.commandName);
  if (!command) {
    logger.warn(`收到未註冊的指令：${interaction.commandName}`);
    return;
  }

  // guild_settings / user_settings 都有 FK 指向這兩張表，先確保紀錄存在，
  // 免得指令因為外鍵限制而失敗
  if (interaction.inGuild() && interaction.guild) {
    upsertGuild(context.db, interaction.guild.id, interaction.guild.name);
  }
  upsertUser(context.db, interaction.user.id, interaction.user.username);

  try {
    await command.execute(interaction, context);
  } catch (error) {
    if (!(error instanceof UserFacingError)) {
      logger.error(`指令 /${interaction.commandName} 執行失敗`, error);
    }

    const content = toUserMessage(error);

    // 已經回覆過就只能用 followUp，否則會拋 InteractionAlreadyReplied
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content, flags: MessageFlags.Ephemeral }).catch(() => undefined);
    } else {
      await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => undefined);
    }
  }
}
