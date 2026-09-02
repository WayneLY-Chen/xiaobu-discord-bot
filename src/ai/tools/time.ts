import type { Tool, ToolResult } from './types.js';
import { validateArgs } from './types.js';

/**
 * 目前時間。
 *
 * 看似多餘，但其實必要：模型不知道「現在」是什麼時候，
 * 沒有這個工具就會拿訓練資料的截止日期當今天，算日期一定錯。
 */
export const timeTool: Tool = {
  definition: {
    name: 'get_current_time',
    description:
      '取得目前的日期與時間。需要知道「今天」「現在」「還有幾天」之類的資訊時一定要先呼叫，不要自己猜。',
    parameters: {
      type: 'object',
      properties: {
        timezone: {
          type: 'string',
          description: 'IANA 時區名稱，例如 Asia/Taipei、Asia/Tokyo、UTC。不給就用伺服器預設時區。',
        },
      },
      required: [],
    },
  },

  async execute(args, context): Promise<ToolResult> {
    const validated = validateArgs(timeTool.definition.parameters, args);
    if (!validated.ok) return { text: `參數有問題：${validated.message}` };

    const requested = typeof validated.value['timezone'] === 'string' ? validated.value['timezone'] : '';
    const timezone = requested.length > 0 ? requested : context.timezone;

    try {
      return { text: formatNow(new Date(), timezone) };
    } catch {
      // 模型可能給出不存在的時區名稱，退回伺服器預設而不是整個失敗
      return { text: `${formatNow(new Date(), context.timezone)}\n（找不到時區「${timezone}」，改用 ${context.timezone}）` };
    }
  },
};

function formatNow(now: Date, timezone: string): string {
  const formatter = new Intl.DateTimeFormat('zh-TW', {
    timeZone: timezone,
    dateStyle: 'full',
    timeStyle: 'short',
    hour12: false,
  });

  return `${formatter.format(now)}（${timezone}）`;
}
