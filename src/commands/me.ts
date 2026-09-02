import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';
import type { BotContext, Command } from '../bot/context.js';
import { MAX_PERSONALITY_LENGTH } from '../config/constants.js';
import { resolveSettings } from '../config/resolveSettings.js';
import {
  ensureUserSettings,
  getGuildSettings,
  resetUserSettings,
  updateUserSettings,
} from '../database/repositories/settings.js';
import { upsertUser } from '../database/repositories/identity.js';
import {
  LOCALE_CHOICES,
  MODEL_CHOICES,
  describe,
  explainUnavailableModel,
  onOff,
  toStoredValue,
} from './shared.js';

export const meCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('me')
    .setDescription('你的個人設定（只影響你自己）')
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) => sub.setName('view').setDescription('查看我的設定'))
    .addSubcommand((sub) =>
      sub
        .setName('model')
        .setDescription('設定你偏好的模型')
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
        .setDescription('設定你偏好的回覆語言')
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
        .setName('personality')
        .setDescription('設定回覆風格；不填則清除')
        .addStringOption((option) =>
          option
            .setName('text')
            .setDescription('例如：講話簡短一點、用比較活潑的語氣')
            .setMaxLength(MAX_PERSONALITY_LENGTH),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('memory')
        .setDescription('開啟或關閉你自己的記憶功能')
        .addBooleanOption((option) =>
          option.setName('enabled').setDescription('是否啟用').setRequired(true),
        ),
    )
    .addSubcommand((sub) => sub.setName('reset').setDescription('還原我的所有個人設定')),

  async execute(interaction, context) {
    const userId = interaction.user.id;
    const { db } = context;

    // user_settings 有 FK 指向 users，先確保 user 存在
    upsertUser(db, userId, interaction.user.username);
    ensureUserSettings(db, userId);

    switch (interaction.options.getSubcommand()) {
      case 'view': {
        await interaction.reply({
          embeds: [buildUserEmbed(interaction, context)],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      case 'model': {
        const model = toStoredValue(interaction.options.getString('model', true));

        if (model) {
          const unavailable = explainUnavailableModel(model, context.router);
          if (unavailable) {
            await reply(interaction, unavailable);
            return;
          }
        }

        updateUserSettings(db, userId, { model });
        await reply(interaction, `你的偏好模型：${model ?? '跟隨伺服器設定'}`);
        return;
      }

      case 'language': {
        const locale = toStoredValue(interaction.options.getString('language', true));
        updateUserSettings(db, userId, { locale });
        await reply(interaction, `你的偏好語言：${locale ?? '跟隨伺服器設定'}`);
        return;
      }

      case 'personality': {
        const text = interaction.options.getString('text');
        updateUserSettings(db, userId, { personality: text ?? null });
        await reply(interaction, text ? '已更新你的回覆風格。' : '已清除你的回覆風格。');
        return;
      }

      case 'memory': {
        const enabled = interaction.options.getBoolean('enabled', true);
        updateUserSettings(db, userId, { memoryEnabled: enabled });
        await reply(interaction, `你的記憶功能已${onOff(enabled)}。`);
        return;
      }

      case 'reset': {
        resetUserSettings(db, userId);
        await reply(interaction, '已還原你的個人設定。');
        return;
      }

      default:
        await reply(interaction, '未知的子指令。');
    }
  },
};

function buildUserEmbed(
  interaction: ChatInputCommandInteraction,
  context: BotContext,
): EmbedBuilder {
  const userRow = ensureUserSettings(context.db, interaction.user.id);
  const guildRow = interaction.guildId
    ? getGuildSettings(context.db, interaction.guildId)
    : undefined;

  const effective = resolveSettings(guildRow, userRow, {
    model: context.env.DEFAULT_MODEL,
    locale: 'zh-TW',
  });

  return new EmbedBuilder()
    .setTitle(`${interaction.user.displayName} 的個人設定`)
    .setColor(0x57f287)
    .addFields(
      { name: '偏好模型', value: describe(userRow.model, '跟隨伺服器設定'), inline: true },
      { name: '偏好語言', value: describe(userRow.locale, '跟隨伺服器設定'), inline: true },
      { name: '記憶功能', value: onOff(userRow.memoryEnabled), inline: true },
      { name: '回覆風格', value: describe(userRow.personality, '未設定') },
      {
        name: '在這個伺服器實際生效',
        value: `模型 ${effective.model}　語言 ${effective.locale}　記憶 ${onOff(effective.memoryEnabled)}`,
      },
    )
    .setFooter({ text: '個人設定跨伺服器共用，但伺服器關閉的功能無法被個人覆寫。' });
}

async function reply(interaction: ChatInputCommandInteraction, content: string): Promise<void> {
  await interaction.reply({ content, flags: MessageFlags.Ephemeral });
}
