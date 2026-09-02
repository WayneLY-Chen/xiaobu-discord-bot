import { QuotaExceededError, UserFacingError } from '../../utils/errors.js';
import { IMAGE_SIZE_IDS, type ImageSize } from '../image/types.js';
import type { Tool, ToolResult } from './types.js';
import { requireString, validateArgs } from './types.js';

/** prompt 太長對生圖沒有幫助，只會拖慢並讓結果更糊。 */
const MAX_PROMPT_LENGTH = 500;

/**
 * 生圖工具（Planning §13）。
 *
 * 規格要求使用者「用講的」就能生圖（「幫我生成一張狐狸」），
 * 所以做成工具而不是斜線指令 —— 由模型判斷什麼時候該畫。
 */
export const imageTool: Tool = {
  requiresImage: true,

  definition: {
    name: 'generate_image',
    description:
      '產生一張圖片。使用者說「畫一張…」「幫我生成…的圖」時使用。' +
      'prompt 請用英文描述並盡量具體（主體、動作、場景、風格、光線），' +
      '生圖模型對英文的理解遠好過中文。使用者用中文描述時由你翻譯成英文。' +
      '這個工具比較慢也比較耗資源，同一次對話不要連續呼叫多張。',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: '英文的圖片描述，越具體越好。例如 "a red fox sleeping on a mossy rock, soft morning light, digital painting"。',
        },
        size: {
          type: 'string',
          description: '畫面比例。方形用 square，橫幅用 landscape，直幅用 portrait。沒特別要求就用 square。',
          enum: IMAGE_SIZE_IDS,
        },
      },
      required: ['prompt'],
    },
  },

  async execute(args, context): Promise<ToolResult> {
    const validated = validateArgs(imageTool.definition.parameters, args);
    if (!validated.ok) return { text: `參數有問題：${validated.message}` };

    const prompt = requireString(validated.value, 'prompt').trim();
    if (!prompt) return { text: '需要一段圖片描述才能生圖。' };

    // 生圖比聊天貴得多，在一般限流之外另外擋一層（規格 §19）
    const quota = context.checkImageQuota();
    if (quota) {
      const seconds = Math.ceil(quota.retryAfterMs / 1000);
      return { text: `這位使用者的生圖次數暫時用完了，還要等大約 ${seconds} 秒。請告訴他稍後再試。` };
    }

    try {
      const image = await context.image.generate({
        prompt: prompt.slice(0, MAX_PROMPT_LENGTH),
        size: readSize(validated.value['size']),
        timeoutMs: context.imageTimeoutMs,
      });

      return {
        // 圖片是用附件送的，模型只需要知道成功了，不要再自己描述一遍畫面內容
        text: '圖片已經產生好，會直接附在你的回覆裡。簡短說一句話帶過就好，不要描述圖片內容。',
        images: [image],
      };
    } catch (error) {
      // 額度用完的訊息是規格指定的字串，要原封不動傳給使用者
      if (error instanceof QuotaExceededError) {
        return { text: `生圖失敗：${error.message}　請把這句話直接告訴使用者。` };
      }

      if (error instanceof UserFacingError) return { text: `生圖失敗：${error.message}` };

      return { text: '生圖失敗，請稍後再試。' };
    }
  },
};

function readSize(raw: unknown): ImageSize {
  return IMAGE_SIZE_IDS.includes(raw as ImageSize) ? (raw as ImageSize) : 'square';
}
