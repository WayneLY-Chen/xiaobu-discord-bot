import {
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import type { Command } from '../bot/context.js';
import { getGuildTopModels, getGuildUsage } from '../database/repositories/usage.js';

export const usageCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('usage')
    .setDescription('查看本伺服器的 AI 用量（需 Manage Guild 權限）')
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addIntegerOption((option) =>
      option
        .setName('days')
        .setDescription('統計最近幾天（預設 7 天）')
        .setMinValue(1)
        .setMaxValue(90),
    ),

  async execute(interaction, context) {
    const guildId = interaction.guildId;
    if (!guildId) return;

    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({
        content: '你需要「管理伺服器」權限才能查看用量。',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const days = interaction.options.getInteger('days') ?? 7;
    const summary = getGuildUsage(context.db, guildId, days);
    const topModels = getGuildTopModels(context.db, guildId, days);

    const modelBreakdown =
      topModels.length > 0
        ? topModels.map((row) => `${row.model} — ${row.requests} 次`).join('\n')
        : '尚無資料';

    const embed = new EmbedBuilder()
      .setTitle(`最近 ${days} 天用量`)
      .setColor(0xfee75c)
      .addFields(
        { name: '請求次數', value: String(summary.requests), inline: true },
        { name: '使用人數', value: String(summary.uniqueUsers), inline: true },
        {
          name: 'Token',
          value: `輸入 ${summary.tokensIn}　輸出 ${summary.tokensOut}`,
          inline: true,
        },
        { name: '模型分布', value: modelBreakdown },
      )
      .setFooter({ text: '只統計本伺服器，不含其他伺服器的資料。' });

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};
