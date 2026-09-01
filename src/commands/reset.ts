import { InteractionContextType, MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { Command } from '../bot/context.js';
import { clearConversation } from '../database/repositories/conversations.js';

export const resetCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('reset')
    .setDescription('清除這個頻道的對話紀錄，重新開始')
    .setContexts(InteractionContextType.Guild),

  async execute(interaction, context) {
    if (!interaction.guildId) return;

    const removed = clearConversation(context.db, interaction.guildId, interaction.channelId);

    await interaction.reply({
      content:
        removed > 0
          ? `已清除這個頻道的 ${removed} 則對話紀錄，我們重新開始。`
          : '這個頻道本來就沒有對話紀錄。',
      flags: MessageFlags.Ephemeral,
    });
  },
};
