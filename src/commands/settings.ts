import {
  ActionRowBuilder,
  ChannelType,
  ChatInputCommandInteraction,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import type { BotContext, Command } from '../bot/context.js';
import { buildSystemInstruction } from '../ai/prompt.js';
import { listMemories } from '../database/repositories/memories.js';
import { chunkMessage } from '../utils/messageChunk.js';
import { TRIGGER_COOLDOWN_SECONDS } from '../events/messageCreate.js';
import { MAX_SYSTEM_PROMPT_LENGTH } from '../config/constants.js';
import {
  addGuildFact,
  listGuildFacts,
  MAX_FACTS_PER_GUILD,
  MAX_FACT_LENGTH,
  removeGuildFact,
} from '../database/repositories/guildFacts.js';
import {
  addGuildTrigger,
  listGuildTriggers,
  MAX_TRIGGERS_PER_GUILD,
  MAX_TRIGGER_PHRASE_LENGTH,
  MAX_TRIGGER_RESPONSE_LENGTH,
  removeGuildTrigger,
} from '../database/repositories/guildTriggers.js';
import { resolveSettings } from '../config/resolveSettings.js';
import {
  ensureGuildSettings,
  getUserSettings,
  resetGuildSettings,
  updateGuildSettings,
} from '../database/repositories/settings.js';
import {
  LOCALE_CHOICES,
  MODEL_CHOICES,
  describe,
  explainUnavailableModel,
  onOff,
  toStoredValue,
} from './shared.js';

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
        .setName('image')
        .setDescription('開啟或關閉生圖功能（預設關閉）')
        .addBooleanOption((option) =>
          option.setName('enabled').setDescription('是否啟用').setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('voice')
        .setDescription('開啟或關閉語音功能（預設開啟）')
        .addBooleanOption((option) =>
          option.setName('enabled').setDescription('是否啟用').setRequired(true),
        ),
    )
    .addSubcommandGroup((group) =>
      group
        .setName('prompt')
        .setDescription('自訂給小步的系統指示')
        .addSubcommand((sub) =>
          sub.setName('edit').setDescription('開一個編輯視窗，裡面已經填好目前的內容'),
        )
        .addSubcommand((sub) =>
          sub.setName('full').setDescription('顯示實際送給模型的完整系統指示'),
        )
        .addSubcommand((sub) => sub.setName('clear').setDescription('清除自訂的系統指示')),
    )
    .addSubcommandGroup((group) =>
      group
        .setName('facts')
        .setDescription('伺服器共用的背景知識，小步跟每個人講話時都會知道')
        .addSubcommand((sub) =>
          sub
            .setName('add')
            .setDescription('新增一條伺服器背景知識')
            .addStringOption((option) =>
              option
                .setName('content')
                .setDescription('例如：本伺服器的「阿凱」是指 @某人；週會固定在每週三晚上八點')
                .setRequired(true)
                .setMaxLength(MAX_FACT_LENGTH),
            ),
        )
        .addSubcommand((sub) => sub.setName('list').setDescription('列出所有伺服器背景知識'))
        .addSubcommand((sub) =>
          sub
            .setName('remove')
            .setDescription('刪除一條伺服器背景知識')
            .addIntegerOption((option) =>
              option
                .setName('id')
                .setDescription('編號（用 /settings facts list 查看）')
                .setRequired(true)
                .setMinValue(1),
            ),
        ),
    )
    .addSubcommandGroup((group) =>
      group
        .setName('trigger')
        .setDescription('聊天出現關鍵字時，小步在語音頻道唸一段固定的台詞')
        .addSubcommand((sub) =>
          sub
            .setName('add')
            .setDescription('新增一組觸發詞與台詞')
            .addStringOption((option) =>
              option
                .setName('phrase')
                .setDescription('關鍵字，至少兩個字。訊息裡出現就會觸發（不分簡繁與大小寫）')
                .setRequired(true)
                .setMinLength(2)
                .setMaxLength(MAX_TRIGGER_PHRASE_LENGTH),
            )
            .addStringOption((option) =>
              option
                .setName('response')
                .setDescription('要唸出來的台詞')
                .setRequired(true)
                .setMaxLength(MAX_TRIGGER_RESPONSE_LENGTH),
            ),
        )
        .addSubcommand((sub) => sub.setName('list').setDescription('列出所有觸發詞'))
        .addSubcommand((sub) =>
          sub
            .setName('remove')
            .setDescription('刪除一組觸發詞')
            .addIntegerOption((option) =>
              option
                .setName('id')
                .setDescription('編號（用 /settings trigger list 查看）')
                .setRequired(true)
                .setMinValue(1),
            ),
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

    if (interaction.options.getSubcommandGroup() === 'facts') {
      await handleFacts(interaction, context, guildId);
      return;
    }

    if (interaction.options.getSubcommandGroup() === 'prompt') {
      await handlePrompt(interaction, context, guildId);
      return;
    }

    if (interaction.options.getSubcommandGroup() === 'trigger') {
      await handleTriggers(interaction, context, guildId);
      return;
    }

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

        if (model) {
          const unavailable = explainUnavailableModel(model, context.router);
          if (unavailable) {
            await reply(interaction, unavailable);
            return;
          }
        }

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

      case 'image': {
        const enabled = interaction.options.getBoolean('enabled', true);
        updateGuildSettings(db, guildId, { imageEnabled: enabled });
        await reply(
          interaction,
          enabled
            ? '生圖功能已開啟。跟小步說「畫一張…」就會生圖。'
            : '生圖功能已關閉。',
        );
        return;
      }

      case 'voice': {
        const enabled = interaction.options.getBoolean('enabled', true);
        updateGuildSettings(db, guildId, { voiceEnabled: enabled });

        // 關掉時要順手把人請出去，否則已經在頻道裡的那一場會繼續跑，
        // 「已關閉」就變成一句空話。
        const left = enabled ? false : (context.voice?.leave(guildId) ?? false);

        await reply(
          interaction,
          enabled
            ? '語音功能已開啟。用 `/voice join` 讓小步進到你所在的語音頻道。'
            : left
              ? '語音功能已關閉，我也離開語音頻道了。'
              : '語音功能已關閉。',
        );
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

/**
 * 伺服器共用背景知識。
 *
 * 與 /memory 的差別：memory 的範圍是 (guild_id, user_id)，每個人自己的；
 * facts 的範圍是 (guild_id)，整個伺服器共用，因此只有 Manage Guild 能改。
 * 內容會直接進 system prompt，由設定的管理員自行負責。
 */
/**
 * 觸發台詞。與 facts 同一套權限模型（Manage Guild），但影響的是語音。
 *
 * 這條路徑會用小步的聲音把管理員輸入的文字**原音播出**，完全不經過模型 ——
 * prompt.ts 裡那些「不要講真實人物壞話」的守則在這裡一條都不生效。
 * 所以權限守在 Manage Guild，內容由設定的管理員自行負責。
 */
/** 編輯視窗的 customId。interactionCreate 靠它認出這是誰送出來的。 */
export const PROMPT_MODAL_ID = 'settings:prompt';
export const PROMPT_INPUT_ID = 'text';

/**
 * 系統指示的檢視與編輯。
 *
 * 改成彈出視窗而不是 slash command 的字串選項，是因為那個輸入框**打不了換行**，
 * 而且每次都要把整段重打一遍 —— 想「改一個字」等於重寫。視窗會預先填入目前的
 * 內容，直接在上面改就好。
 */
async function handlePrompt(
  interaction: ChatInputCommandInteraction,
  context: BotContext,
  guildId: string,
): Promise<void> {
  const { db } = context;

  switch (interaction.options.getSubcommand()) {
    case 'edit': {
      const current = ensureGuildSettings(db, guildId).systemPrompt ?? '';

      const input = new TextInputBuilder()
        .setCustomId(PROMPT_INPUT_ID)
        .setLabel('給小步的額外指示')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false)
        .setMaxLength(MAX_SYSTEM_PROMPT_LENGTH)
        .setPlaceholder('例如：回答盡量簡短；提到公司內部系統時一律用英文原名')
        .setValue(current);

      await interaction.showModal(
        new ModalBuilder()
          .setCustomId(PROMPT_MODAL_ID)
          .setTitle('編輯系統指示')
          .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input)),
      );
      return;
    }

    case 'clear': {
      updateGuildSettings(db, guildId, { systemPrompt: null });
      await reply(interaction, '已清除自訂的系統指示。小步的預設人格不受影響。');
      return;
    }

    case 'full': {
      // 這裡刻意用與 ChatService 完全相同的組法，否則顯示的東西跟實際送出去的會不一樣
      const guildRow = ensureGuildSettings(db, guildId);
      const userRow = getUserSettings(db, interaction.user.id);
      const settings = resolveSettings(guildRow, userRow, {
        model: context.env.DEFAULT_MODEL,
        locale: 'zh-TW',
      });

      const full = buildSystemInstruction({
        botName: context.chat.name,
        guildName: interaction.guild?.name ?? '這個伺服器',
        channelName: interaction.channel && 'name' in interaction.channel
          ? (interaction.channel.name ?? '某個頻道')
          : '某個頻道',
        speaker: interaction.member && 'displayName' in interaction.member
          ? interaction.member.displayName
          : interaction.user.displayName,
        locale: settings.locale,
        guildSystemPrompt: settings.systemPrompt,
        userPersonality: settings.personality,
        guildFacts: listGuildFacts(db, guildId).map((row) => row.content),
        memories: settings.memoryEnabled
          ? listMemories(db, guildId, interaction.user.id).map((row) => ({
              id: row.id,
              content: row.content,
            }))
          : [],
        toolsAvailable: true,
      });

      const chunks = chunkMessage([
        '這是**現在**送給模型的完整系統指示（以你的身分、這個頻道為準）：',
        '',
        full,
      ].join('\n'));

      await interaction.reply({ content: chunks[0] ?? '（空的）', flags: MessageFlags.Ephemeral });
      for (const chunk of chunks.slice(1)) {
        await interaction.followUp({ content: chunk, flags: MessageFlags.Ephemeral });
      }
      return;
    }

    default:
      await reply(interaction, '未知的子指令。');
  }
}

async function handleTriggers(
  interaction: ChatInputCommandInteraction,
  context: BotContext,
  guildId: string,
): Promise<void> {
  const { db } = context;

  switch (interaction.options.getSubcommand()) {
    case 'add': {
      const phrase = interaction.options.getString('phrase', true);
      const response = interaction.options.getString('response', true);
      const outcome = addGuildTrigger(db, guildId, phrase, response, interaction.user.id);

      const message =
        outcome.status === 'added'
          ? `已新增觸發詞「${phrase}」（目前 ${outcome.total}/${MAX_TRIGGERS_PER_GUILD} 組）。\n` +
            '小步**在語音頻道裡**的時候，只要跟她在同一個頻道的人講到這個詞就會唸出來。\n' +
            `同一個伺服器每 ${TRIGGER_COOLDOWN_SECONDS} 秒最多唸一次。`
          : outcome.status === 'duplicate'
            ? '這個觸發詞已經有了。'
            : outcome.status === 'phrase-too-short'
              ? '觸發詞至少要兩個字，而且不能只有標點或空白 —— 否則每一則訊息都會命中。'
              : `觸發詞已達上限（${MAX_TRIGGERS_PER_GUILD} 組），請先刪掉幾個。`;

      await reply(interaction, message);
      return;
    }

    case 'list': {
      const rows = listGuildTriggers(db, guildId);

      if (rows.length === 0) {
        await reply(interaction, '目前沒有設定任何觸發詞。');
        return;
      }

      // embed 的 description 上限是 4096 字元，而單一台詞就可能有 600 字。
      // 這裡只顯示開頭，管理員要的是「有哪些、編號幾號」而不是全文。
      const lines = rows.map(
        (row) => `**#${row.id}**　\`${row.phraseRaw}\` → ${preview(row.response)}`,
      );

      const embed = new EmbedBuilder()
        .setTitle(`觸發台詞（${rows.length}/${MAX_TRIGGERS_PER_GUILD}）`)
        .setColor(0x5865f2)
        .setDescription(lines.join('\n'))
        .setFooter({ text: '用 /settings trigger remove id:<編號> 刪除' });

      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      return;
    }

    case 'remove': {
      const id = interaction.options.getInteger('id', true);
      const removed = removeGuildTrigger(db, guildId, id);
      await reply(interaction, removed ? `已刪除 #${id}。` : `找不到 #${id}。`);
      return;
    }

    default:
      await reply(interaction, '未知的子指令。');
  }
}

/** 台詞在列表裡只顯示開頭，避免十條就把 embed 的 4096 字元撐爆。 */
function preview(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= 60 ? oneLine : `${oneLine.slice(0, 60)}…`;
}

async function handleFacts(
  interaction: ChatInputCommandInteraction,
  context: BotContext,
  guildId: string,
): Promise<void> {
  const { db } = context;

  switch (interaction.options.getSubcommand()) {
    case 'add': {
      const content = interaction.options.getString('content', true);
      const outcome = addGuildFact(db, guildId, content, interaction.user.id);

      await reply(
        interaction,
        outcome.status === 'duplicate'
          ? '這條背景知識已經存在了。'
          : outcome.status === 'full'
            ? `已達上限（${MAX_FACTS_PER_GUILD} 條），請先用 \`/settings facts remove\` 刪掉一些。`
            : `已新增（目前共 ${outcome.total} 條）。小步之後跟這個伺服器的人講話都會知道這件事。`,
      );
      return;
    }

    case 'list': {
      const rows = listGuildFacts(db, guildId);

      if (rows.length === 0) {
        await reply(interaction, '目前沒有設定任何伺服器背景知識。');
        return;
      }

      const embed = new EmbedBuilder()
        .setTitle(`${interaction.guild?.name ?? '這個伺服器'} 的背景知識`)
        .setColor(0xfee75c)
        .setDescription(
          rows.map((row) => `\`#${row.id}\` ${row.content}　—　<@${row.createdBy}>`).join('\n'),
        )
        .setFooter({
          text: `${rows.length} / ${MAX_FACTS_PER_GUILD} 條　全伺服器共用，內容由新增的管理員負責`,
        });

      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      return;
    }

    case 'remove': {
      const id = interaction.options.getInteger('id', true);
      const removed = removeGuildFact(db, guildId, id);

      await reply(
        interaction,
        removed ? `已刪除 #${id}。` : `找不到編號 #${id}。用 \`/settings facts list\` 確認編號。`,
      );
      return;
    }

    default:
      await reply(interaction, '未知的子指令。');
  }
}

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
      { name: '生圖功能', value: onOff(guildRow.imageEnabled), inline: true },
      { name: '語音功能', value: onOff(guildRow.voiceEnabled), inline: true },
      { name: '系統指示', value: systemPrompt },
      {
        name: '對你目前生效的設定',
        value: `模型 ${effective.model}　語言 ${effective.locale}`,
      },
    )
    .setFooter({ text: '個人設定可以再關掉自己的記憶，但不能打開伺服器關掉的功能。' });
}

async function reply(
  interaction: ChatInputCommandInteraction,
  content: string,
): Promise<void> {
  await interaction.reply({ content, flags: MessageFlags.Ephemeral });
}
