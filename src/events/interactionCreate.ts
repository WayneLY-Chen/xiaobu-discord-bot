import {
  Events,
  MessageFlags,
  PermissionFlagsBits,
  type Client,
  type Interaction,
  type ModalSubmitInteraction,
} from 'discord.js';
import type { BotContext } from '../bot/context.js';
import { commandsByName } from '../commands/index.js';
import { PROMPT_INPUT_ID, PROMPT_MODAL_ID } from '../commands/settings.js';
import { ensureGuildSettings, updateGuildSettings } from '../database/repositories/settings.js';
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
  if (interaction.isModalSubmit()) {
    await handlePromptModal(interaction, context);
    return;
  }

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

/**
 * /settings prompt edit 那個編輯視窗送出來的內容。
 *
 * 權限在這裡**再檢查一次**：視窗打開到按下送出之間可能隔了好幾分鐘，
 * 中間權限被拔掉的話不該還讓它寫進去。
 */
async function handlePromptModal(
  interaction: ModalSubmitInteraction,
  context: BotContext,
): Promise<void> {
  if (interaction.customId !== PROMPT_MODAL_ID) return;
  if (!interaction.guildId) return;

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({
      content: '你需要「管理伺服器」權限才能修改設定。',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const text = interaction.fields.getTextInputValue(PROMPT_INPUT_ID).trim();
  ensureGuildSettings(context.db, interaction.guildId);
  updateGuildSettings(context.db, interaction.guildId, {
    systemPrompt: text.length > 0 ? text : null,
  });

  await interaction.reply({
    content:
      text.length > 0
        ? `已更新系統指示（${text.length} 字）。用 \`/settings prompt full\` 可以看實際送給模型的完整版本。`
        : '內容是空的，已清除自訂的系統指示。',
    flags: MessageFlags.Ephemeral,
  });
}
