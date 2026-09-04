import {
  ChannelType,
  DiscordAPIError,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type VoiceBasedChannel,
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

    if (!interaction.inCachedGuild()) {
      await interaction.reply({
        content: '這個指令只能在伺服器裡使用。',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // 先 defer 再做事。後面要打 REST 查語音狀態、還要建立語音連線，
    // 隨便一項都可能超過互動的 3 秒回覆期限 —— 閒置很久之後的第一個指令，
    // 光是把行程喚醒就吃掉好幾秒（正式機只有 954MB RAM，會被換出去）。
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (!voice) {
      await interaction.editReply('語音功能目前沒有啟用（找不到語音合成的模型檔案）。');
      return;
    }

    if (interaction.options.getSubcommand() === 'leave') {
      const left = voice.leave(interaction.guildId);
      await interaction.editReply(left ? '我離開語音頻道了。' : '我目前不在任何語音頻道。');
      return;
    }

    const channel = await resolveVoiceChannel(interaction);

    if (!channel) {
      await interaction.editReply(
        '你要先自己進到一個語音頻道，我才知道要加入哪一個。\n' +
          '（我剛剛跟 Discord 確認過，你目前沒有連在任何語音頻道上。）',
      );
      return;
    }

    // Stage 頻道的發言權限模型不一樣（要先成為講者），這裡不支援
    if (channel.type !== ChannelType.GuildVoice) {
      await interaction.editReply('我目前只能加入一般的語音頻道。');
      return;
    }

    const me = channel.permissionsFor(interaction.guild.members.me!);
    if (!me?.has(PermissionFlagsBits.Connect) || !me.has(PermissionFlagsBits.Speak)) {
      await interaction.editReply(`我沒有「連線」或「說話」的權限，進不了 ${channel.name}。`);
      return;
    }

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

/**
 * 找出使用者目前所在的語音頻道。
 *
 * 先看 gateway 快取，落空就直接問 Discord REST。快取落空的情況比想像中多：
 * 少了 GuildVoiceStates intent、Bot 上線前對方就已經在頻道裡、或事件在重連
 * 期間掉了。多打一次 API，換到不會莫名其妙說「你不在語音頻道」很划算 ——
 * 那個訊息以前是唯一的失敗路徑，而且完全不留紀錄，等於瞎子摸象。
 */
export async function resolveVoiceChannel(
  interaction: ChatInputCommandInteraction<'cached'>,
): Promise<VoiceBasedChannel | null> {
  const cached = interaction.member.voice.channel;
  if (cached) return cached;

  let channelId: string | null;

  try {
    const state = await interaction.guild.voiceStates.fetch(interaction.user.id, { force: true });
    channelId = state.channelId;
    if (state.channel) return state.channel;
  } catch (error) {
    // 沒連在語音頻道時 Discord 回 404，那是正常結果不是故障
    if (!(error instanceof DiscordAPIError) || error.status !== 404) {
      logger.warn(`查詢語音狀態失敗：${toUserMessage(error)}`);
    }
    return null;
  }

  if (!channelId) return null;

  // 語音狀態有頻道、但頻道不在快取裡（例如剛建立的頻道）—— 再抓一次
  const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
  return channel?.isVoiceBased() ? channel : null;
}
