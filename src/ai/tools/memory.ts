import {
  addMemory,
  deleteMemory,
  listMemories,
  MAX_MEMORIES_PER_USER,
  MAX_MEMORY_LENGTH,
} from '../../database/repositories/memories.js';
import type { Tool, ToolResult } from './types.js';
import { requireString, validateArgs } from './types.js';

/**
 * 記住一件事。
 *
 * 規格 §16 明確要求「不要把所有聊天訊息都直接存成長期 Memory」——
 * 所以這是一個工具，只有使用者真的表達「記住…」時模型才會呼叫，
 * 而不是每則訊息都往資料庫塞。
 *
 * 範圍是 (guild_id, user_id)：同一個人在不同伺服器是兩份，互不互通（§17）。
 */
export const rememberTool: Tool = {
  requiresMemory: true,

  definition: {
    name: 'remember',
    description:
      '把使用者要你長期記住的事情存起來（例如偏好、稱呼、正在做的專案）。' +
      '只有使用者明確要你記住、或講到明顯值得長期記得的個人資訊時才呼叫。' +
      '一般閒聊不要存。',
    parameters: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description:
            '要記住的內容，用完整的一句話寫清楚，例如「Wayne 偏好用 Qwen 模型」。' +
            '寫成之後單獨看也看得懂的敘述，不要只寫「喜歡這個」。',
        },
      },
      required: ['content'],
    },
  },

  async execute(args, context): Promise<ToolResult> {
    const validated = validateArgs(rememberTool.definition.parameters, args);
    if (!validated.ok) return { text: `參數有問題：${validated.message}` };

    const content = requireString(validated.value, 'content').trim();
    if (content.length === 0) return { text: '沒有內容可以記。' };

    const outcome = addMemory(context.db, context.guildId, context.userId, content);

    switch (outcome.status) {
      case 'duplicate':
        return { text: `這件事已經記過了：「${content}」。告訴使用者你本來就記得。` };
      case 'full':
        return {
          text:
            `記憶已經滿了（上限 ${MAX_MEMORIES_PER_USER} 則）。` +
            '請使用者用 /memory list 看看，再用 /memory delete 刪掉不需要的。',
        };
      default:
        return { text: `已記住：「${content.slice(0, MAX_MEMORY_LENGTH)}」（目前共 ${outcome.total} 則）` };
    }
  },
};

/** 讓模型主動查自己記得什麼。平常記憶會自動注入，但被追問細節時可以再查一次。 */
export const recallTool: Tool = {
  requiresMemory: true,

  definition: {
    name: 'recall_memories',
    description:
      '列出你對目前這位使用者記住的所有事情。被問到「你記得我什麼」或需要確認細節時使用。',
    parameters: { type: 'object', properties: {}, required: [] },
  },

  async execute(_args, context): Promise<ToolResult> {
    const rows = listMemories(context.db, context.guildId, context.userId);

    if (rows.length === 0) {
      return { text: '目前對這位使用者沒有任何長期記憶。' };
    }

    return {
      text: ['目前記得這些事：', ...rows.map((row) => `#${row.id} ${row.content}`)].join('\n'),
    };
  },
};

/** 讓使用者用講的就能刪掉記錯的事，不必去翻 /memory delete 的 id。 */
export const forgetTool: Tool = {
  requiresMemory: true,

  definition: {
    name: 'forget',
    description:
      '刪掉一則長期記憶。使用者說「忘掉…」「那個記錯了」時使用。' +
      '如果不確定是哪一則，先用 recall_memories 看清楚再刪。',
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'number',
          description: '要刪除的記憶編號，來自 recall_memories 列出的 #編號。',
        },
      },
      required: ['id'],
    },
  },

  async execute(args, context): Promise<ToolResult> {
    const validated = validateArgs(forgetTool.definition.parameters, args);
    if (!validated.ok) return { text: `參數有問題：${validated.message}` };

    const id = validated.value['id'];
    if (typeof id !== 'number' || !Number.isInteger(id)) {
      return { text: '記憶編號必須是整數。' };
    }

    const deleted = deleteMemory(context.db, context.guildId, context.userId, id);

    return {
      text: deleted
        ? `已刪除記憶 #${id}。`
        : `找不到編號 #${id} 的記憶（可能已經刪掉，或那不是這位使用者的記憶）。`,
    };
  },
};
