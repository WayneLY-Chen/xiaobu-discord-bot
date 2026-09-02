import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';
import type { Command } from '../bot/context.js';
import { resolveSettings } from '../config/resolveSettings.js';
import { upsertUser } from '../database/repositories/identity.js';
import {
  addMemory,
  clearMemories,
  deleteMemory,
  listMemories,
  MAX_MEMORIES_PER_USER,
  MAX_MEMORY_LENGTH,
} from '../database/repositories/memories.js';
import { ensureGuildSettings, ensureUserSettings } from '../database/repositories/settings.js';

/**
 * 長期記憶的指令（規格 §16「User 可以控制自己的 Memory」）。
 *
 * 範圍是 (guild_id, user_id)：你在這個伺服器的記憶，別的伺服器看不到，
 * 別人也看不到你的。所有回覆都是 ephemeral —— 記憶內容是個人資料，
 * 不該因為打了一個指令就公開在頻道上。
 */
export const memoryCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('memory')
    .setDescription('管理小步對你的長期記憶（只有你看得到）')
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) => sub.setName('list').setDescription('列出小步記得你的哪些事'))
    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription('手動新增一則記憶')
        .addStringOption((option) =>
          option
            .setName('content')
            .setDescription('要記住的事，寫成完整一句話')
            .setRequired(true)
            .setMaxLength(MAX_MEMORY_LENGTH),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('delete')
        .setDescription('刪除一則記憶')
        .addIntegerOption((option) =>
          option
            .setName('id')
            .setDescription('記憶編號（用 /memory list 查看）')
            .setRequired(true)
            .setMinValue(1),
        ),
    )
    .addSubcommand((sub) => sub.setName('clear').setDescription('清空你在這個伺服器的所有記憶')),

  async execute(interaction, context) {
    const guildId = interaction.guildId;
    if (!guildId) {
      await reply(interaction, '這個指令只能在伺服器中使用。');
      return;
    }

    const userId = interaction.user.id;
    const { db } = context;

    upsertUser(db, userId, interaction.user.username);
    const userRow = ensureUserSettings(db, userId);
    const guildRow = ensureGuildSettings(db, guildId);

    const settings = resolveSettings(guildRow, userRow, {
      model: context.env.DEFAULT_MODEL,
      locale: 'zh-TW',
    });

    // 記憶被關掉時仍然允許 list / delete / clear —— 使用者必須看得到、
    // 也刪得掉已經存在的資料，這是最基本的資料控制權。只擋新增。
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'add' && !settings.memoryEnabled) {
      const who = guildRow.memoryEnabled ? '你自己（用 `/me memory` 開啟）' : '伺服器管理員';
      await reply(interaction, `記憶功能目前是關閉的，關閉的人是 ${who}。`);
      return;
    }

    switch (subcommand) {
      case 'list': {
        const rows = listMemories(db, guildId, userId);

        if (rows.length === 0) {
          await reply(interaction, '小步目前沒有記得你的任何事。跟她說「記住我…」就會記起來。');
          return;
        }

        const embed = new EmbedBuilder()
          .setTitle(`小步記得 ${interaction.user.displayName} 的事`)
          .setColor(0x5865f2)
          .setDescription(rows.map((row) => `\`#${row.id}\` ${row.content}`).join('\n'))
          .setFooter({
            text: `${rows.length} / ${MAX_MEMORIES_PER_USER} 則　只在這個伺服器有效，其他伺服器是獨立的`,
          });

        await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
        return;
      }

      case 'add': {
        const content = interaction.options.getString('content', true);
        const outcome = addMemory(db, guildId, userId, content);

        await reply(
          interaction,
          outcome.status === 'duplicate'
            ? '這件事已經記過了。'
            : outcome.status === 'full'
              ? `記憶已滿（上限 ${MAX_MEMORIES_PER_USER} 則），請先用 \`/memory delete\` 刪掉一些。`
              : `已記住（目前共 ${outcome.total} 則）。`,
        );
        return;
      }

      case 'delete': {
        const id = interaction.options.getInteger('id', true);
        const deleted = deleteMemory(db, guildId, userId, id);

        await reply(
          interaction,
          deleted ? `已刪除記憶 #${id}。` : `找不到編號 #${id} 的記憶。用 \`/memory list\` 確認編號。`,
        );
        return;
      }

      case 'clear': {
        const removed = clearMemories(db, guildId, userId);
        await reply(
          interaction,
          removed === 0 ? '本來就沒有任何記憶。' : `已清空 ${removed} 則記憶。`,
        );
        return;
      }

      default:
        await reply(interaction, '未知的子指令。');
    }
  },
};

async function reply(interaction: ChatInputCommandInteraction, content: string): Promise<void> {
  await interaction.reply({ content, flags: MessageFlags.Ephemeral });
}
