import {
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';
import type { Command } from '../bot/context.js';

export const helpCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('顯示 Bot 使用說明')
    .setContexts(InteractionContextType.Guild),

  async execute(interaction, context) {
    const searchEnabled = context.chat.searchEnabled;
    const imageEnabled = context.chat.imageEnabled;

    const embed = new EmbedBuilder()
      .setTitle('使用說明')
      .setColor(0x5865f2)
      .setDescription(
        [
          '在管理員設定的 AI 頻道裡直接說話，或是 @我 就能開始聊天。',
          '同一個頻道的對話是共用的，我會記得誰說了什麼。',
        ].join('\n'),
      )
      .addFields(
        {
          name: '聊天',
          value: [
            '`@Bot 你的問題` — 在任何頻道呼叫我',
            '`/reset` — 清除這個頻道的對話紀錄',
          ].join('\n'),
        },
        {
          name: '我會自己用的工具',
          value: [
            searchEnabled ? '🔎 **網路搜尋** — 問我新聞或即時資訊，我會查了再回答，並附上來源' : null,
            '🌤️ **天氣** — 問某個城市的天氣與未來三天預報',
            '🧮 **計算機** — 需要精算的數字我會算給你，不用心算',
            '🕐 **時間** — 現在幾點、今天幾號、距離某天還有幾天',
            '🧠 **記憶** — 跟我說「記住…」，我下次還會記得',
            imageEnabled
              ? '🎨 **生圖** — 說「畫一張…」我就畫（要管理員先用 `/settings image` 開啟）'
              : null,
            '',
            '這些不用打指令，直接用講的就好。',
          ]
            .filter((line): line is string => line !== null)
            .join('\n'),
        },
        {
          name: '長期記憶',
          value: [
            '`/memory list` — 看我記得你哪些事',
            '`/memory add` — 手動新增一則',
            '`/memory delete` — 刪掉一則',
            '`/memory clear` — 全部清空',
            '記憶只在目前這個伺服器有效，別的伺服器是分開的，別人也看不到你的。',
          ].join('\n'),
        },
        {
          name: '個人設定',
          value: [
            '`/me view` — 查看我的設定',
            '`/me model` — 選擇偏好的模型',
            '`/me language` — 設定回覆語言',
            '`/me personality` — 設定回覆風格',
            '`/me memory` — 開啟／關閉自己的記憶',
            '`/me reset` — 還原個人設定',
          ].join('\n'),
        },
        {
          name: '伺服器設定（需 Manage Guild 權限）',
          value: [
            '`/settings view` — 查看伺服器設定',
            '`/settings ai-channel` — 指定 AI 頻道',
            '`/settings model` — 預設模型',
            '`/settings chat` — 開啟／關閉聊天',
            '`/settings prompt` — 自訂系統指示',
            '`/settings facts add|list|remove` — 伺服器共用的背景知識',
            '`/settings reset` — 還原伺服器設定',
            '`/usage` — 查看本伺服器用量',
          ].join('\n'),
        },
        {
          name: '尚未開放',
          value: '生圖、音樂、語音仍在開發中，目前不可使用。',
        },
      )
      .setFooter({ text: '個人設定優先於伺服器設定；伺服器關閉的功能無法被個人覆寫。' });

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};
