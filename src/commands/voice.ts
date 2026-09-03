import {
  ChannelType,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { BotContext, Command } from '../bot/context.js';
import { toUserMessage } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

/**
 * 語音頻道指令（規格 §15）。
 *
 * 只有加入／離開兩個動作 —— 進去之後直接對小步說話就好，
 * 不需要再打任何指令。
 */
export const voiceCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('voice')
    .setDescription('讓小步加入或離開語音頻道')
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) =>
      sub.setName('join').setDescription('讓小步加入你目前所在的語音頻道'),
    )
    .addSubcommand((sub) => sub.setName('leave').setDescription('讓小步離開語音頻道')),

  async execute(interaction: ChatInputCommandInteraction, context: BotContext): Promise<void> {
    const { voice } = context;

    if (!voice) {
      await reply(interaction, '語音功能目前沒有啟用（找不到語音合成的模型檔案）。');
      return;
    }

    if (!interaction.inCachedGuild()) {
      await reply(interaction, '這個指令只能在伺服器裡使用。');
      return;
    }

    if (interaction.options.getSubcommand() === 'leave') {
      const left = voice.leave(interaction.guildId);
      await reply(interaction, left ? '我離開語音頻道了。' : '我目前不在任何語音頻道。');
      return;
    }

    const channel = interaction.member.voice.channel;

    if (!channel) {
      await reply(interaction, '你要先自己進到一個語音頻道，我才知道要加入哪一個。');
      return;
    }

    // Stage 頻道的發言權限模型不一樣（要先成為講者），這裡不支援
    if (channel.type !== ChannelType.GuildVoice) {
      await reply(interaction, '我目前只能加入一般的語音頻道。');
      return;
    }

    const me = channel.permissionsFor(interaction.guild.members.me!);
    if (!me?.has(PermissionFlagsBits.Connect) || !me.has(PermissionFlagsBits.Speak)) {
      await reply(interaction, `我沒有「連線」或「說話」的權限，進不了 ${channel.name}。`);
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      await voice.join(channel);
      await interaction.editReply(
        `我進來 **${channel.name}** 了，直接說話就好。\n` +
          '講完停一下我就會回答。要我出去的話用 `/voice leave`。',
      );
    } catch (error) {
      logger.warn(`加入語音頻道失敗：${toUserMessage(error)}`);
      await interaction.editReply(toUserMessage(error));
    }
  },
};

async function reply(interaction: ChatInputCommandInteraction, content: string): Promise<void> {
  await interaction.reply({ content, flags: MessageFlags.Ephemeral });
}
