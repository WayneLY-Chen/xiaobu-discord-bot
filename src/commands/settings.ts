import {
  ChannelType,
  ChatInputCommandInteraction,
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import type { BotContext, Command } from '../bot/context.js';
import { MAX_SYSTEM_PROMPT_LENGTH } from '../config/constants.js';
import { resolveSettings } from '../config/resolveSettings.js';
import {
  ensureGuildSettings,
  getUserSettings,
  resetGuildSettings,
  updateGuildSettings,
} from '../database/repositories/settings.js';
import { LOCALE_CHOICES, MODEL_CHOICES, describe, onOff, toStoredValue } from './shared.js';

export const settingsCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('settings')
    .setDescription('伺服器設定（需 Manage Guild 權限）')
    .setContexts(InteractionContextType.Guild)
    // 這只是把指令從 UI 隱藏，實際權限在 execute 內會再檢查一次
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) => sub.setName('view').setDescription('查看目前設定'))
    .addSubcommand((sub) =>
      sub
        .setName('ai-channel')
        .setDescription('指定 AI 頻道；不填則取消指定（之後只有 @Bot 會回應）')
        .addChannelOption((option) =>
          option
            .setName('channel')
            .setDescription('要讓 Bot 自動回應的頻道')
            .addChannelTypes(ChannelType.GuildText),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('model')
        .setDescription('設定伺服器預設模型')
        .addStringOption((option) =>
          option
            .setName('model')
            .setDescription('模型')
            .setRequired(true)
            .addChoices(...MODEL_CHOICES),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('language')
        .setDescription('設定伺服器預設回覆語言')
        .addStringOption((option) =>
          option
            .setName('language')
            .setDescription('語言')
            .setRequired(true)
            .addChoices(...LOCALE_CHOICES),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('chat')
        .setDescription('開啟或關閉整個伺服器的 AI 聊天')
        .addBooleanOption((option) =>
          option.setName('enabled').setDescription('是否啟用').setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('memory')
        .setDescription('開啟或關閉整個伺服器的記憶功能')
        .addBooleanOption((option) =>
          option.setName('enabled').setDescription('是否啟用').setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('prompt')
        .setDescription('自訂系統指示；不填則清除')
        .addStringOption((option) =>
          option
            .setName('text')
            .setDescription('給 AI 的額外指示')
            .setMaxLength(MAX_SYSTEM_PROMPT_LENGTH),
        ),
    )
    .addSubcommand((sub) => sub.setName('reset').setDescription('還原所有伺服器設定')),

  async execute(interaction, context) {
    const guildId = interaction.guildId;
    if (!guildId) return;

    // 就算管理員改過 Discord 端的預設權限，這裡仍然守住
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await reply(interaction, '你需要「管理伺服器」權限才能修改設定。');
      return;
    }

    const { db, env } = context;
    ensureGuildSettings(db, guildId);

    switch (interaction.options.getSubcommand()) {
      case 'view': {
        const embed = buildSettingsEmbed(
          interaction.guild?.name ?? '這個伺服器',
          context,
          guildId,
          interaction.user.id,
        );
        await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
        return;
      }

      case 'ai-channel': {
        const channel = interaction.options.getChannel('channel');
        updateGuildSettings(db, guildId, { aiChannelId: channel?.id ?? null });
        await reply(
          interaction,
          channel
            ? `AI 頻道已設定為 <#${channel.id}>，在那裡直接說話我就會回覆。`
            : '已取消 AI 頻道指定，之後只有 @我 才會回覆。',
        );
        return;
      }

      case 'model': {
        const model = toStoredValue(interaction.options.getString('model', true));
        updateGuildSettings(db, guildId, { model });
        await reply(
          interaction,
          `伺服器預設模型：${model ?? `跟隨系統預設（${env.DEFAULT_MODEL}）`}`,
        );
        return;
      }

      case 'language': {
        const locale = toStoredValue(interaction.options.getString('language', true));
        updateGuildSettings(db, guildId, { locale });
        await reply(interaction, `伺服器預設語言：${locale ?? '跟隨系統預設（zh-TW）'}`);
        return;
      }

      case 'chat': {
        const enabled = interaction.options.getBoolean('enabled', true);
        updateGuildSettings(db, guildId, { chatEnabled: enabled });
        await reply(interaction, `AI 聊天已${onOff(enabled)}。`);
        return;
      }

      case 'memory': {
        const enabled = interaction.options.getBoolean('enabled', true);
        updateGuildSettings(db, guildId, { memoryEnabled: enabled });
        await reply(interaction, `記憶功能已${onOff(enabled)}。`);
        return;
      }

      case 'prompt': {
        const text = interaction.options.getString('text');
        updateGuildSettings(db, guildId, { systemPrompt: text ?? null });
        await reply(interaction, text ? '已更新系統指示。' : '已清除系統指示。');
        return;
      }

      case 'reset': {
        resetGuildSettings(db, guildId);
        await reply(interaction, '已還原所有伺服器設定。');
        return;
      }

      default:
        await reply(interaction, '未知的子指令。');
    }
  },
};

function buildSettingsEmbed(
  guildName: string,
  context: BotContext,
  guildId: string,
  userId: string,
): EmbedBuilder {
  const guildRow = ensureGuildSettings(context.db, guildId);
  const userRow = getUserSettings(context.db, userId);
  const effective = resolveSettings(guildRow, userRow, {
    model: context.env.DEFAULT_MODEL,
    locale: 'zh-TW',
  });

  const systemPrompt = guildRow.systemPrompt
    ? ['```', guildRow.systemPrompt, '```'].join('\n')
    : '未設定';

  return new EmbedBuilder()
    .setTitle(`${guildName} 的設定`)
    .setColor(0x5865f2)
    .addFields(
      {
        name: 'AI 頻道',
        value: guildRow.aiChannelId
          ? `<#${guildRow.aiChannelId}>`
          : '未指定（只有 @Bot 會回應）',
      },
      {
        name: '預設模型',
        value: describe(guildRow.model, `跟隨系統預設（${context.env.DEFAULT_MODEL}）`),
        inline: true,
      },
      {
        name: '預設語言',
        value: describe(guildRow.locale, '跟隨系統預設（zh-TW）'),
        inline: true,
      },
      { name: 'AI 聊天', value: onOff(guildRow.chatEnabled), inline: true },
      { name: '記憶功能', value: onOff(guildRow.memoryEnabled), inline: true },
      { name: '系統指示', value: systemPrompt },
      {
        name: '對你目前生效的設定',
        value: `模型 ${effective.model}　語言 ${effective.locale}`,
      },
    )
    .setFooter({ text: '生圖、音樂、語音尚未實作，開關暫時無效。' });
}

async function reply(
  interaction: ChatInputCommandInteraction,
  content: string,
): Promise<void> {
  await interaction.reply({ content, flags: MessageFlags.Ephemeral });
}
