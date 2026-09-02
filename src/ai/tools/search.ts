import { UserFacingError } from '../../utils/errors.js';
import type { SearchResult } from '../search/types.js';
import type { Tool, ToolResult } from './types.js';
import { requireString, validateArgs } from './types.js';

const MAX_RESULTS = 5;
const MAX_SNIPPET_LENGTH = 400;

/**
 * 網路搜尋。
 *
 * 回給模型的文字每一筆都標了編號與網址，最終回覆下方的來源清單則是直接用
 * 實際 API 回傳的資料組出來的（見 ToolResult.sources）——
 * 規格 §12 要求「不得捏造來源」，所以網址不能讓模型轉述。
 */
export const searchTool: Tool = {
  definition: {
    name: 'web_search',
    description:
      '搜尋網路上的即時資訊。需要新聞、目前狀況、價格、版本號、或任何你不確定且可能已經改變的事情時使用。' +
      '一般常識或純聊天不需要搜尋。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '搜尋關鍵字。用最能查到結果的語言，通常英文比較準。',
        },
        recent: {
          type: 'boolean',
          description: '要找的是近期新聞就設 true，會優先回傳有發布日期的新聞來源。',
        },
      },
      required: ['query'],
    },
  },

  async execute(args, context): Promise<ToolResult> {
    const validated = validateArgs(searchTool.definition.parameters, args);
    if (!validated.ok) return { text: `參數有問題：${validated.message}` };

    const query = requireString(validated.value, 'query').trim();
    if (query.length === 0) return { text: '請提供搜尋關鍵字。' };

    if (!context.search.enabled) {
      return { text: '目前沒有可用的搜尋服務，請根據既有知識回答，並說明無法查證。' };
    }

    try {
      const outcome = await context.search.search(query, {
        maxResults: MAX_RESULTS,
        timeoutMs: context.timeoutMs,
        recentOnly: validated.value['recent'] === true,
      });

      if (outcome.results.length === 0) {
        return { text: `「${query}」沒有搜尋到結果。老實告訴使用者查不到，不要自己編。` };
      }

      return {
        text: formatForModel(query, outcome.results),
        sources: outcome.results,
      };
    } catch (error) {
      const reason = error instanceof UserFacingError ? error.message : '搜尋服務暫時無法使用。';
      return { text: `搜尋失敗：${reason} 請據實告訴使用者這次查不到，不要編造內容。` };
    }
  },
};

function formatForModel(query: string, results: SearchResult[]): string {
  const lines = [`「${query}」的搜尋結果：`, ''];

  for (const [index, result] of results.entries()) {
    lines.push(`[${index + 1}] ${result.title}`);
    lines.push(`　網址：${result.url}`);
    if (result.publishedAt) lines.push(`　日期：${result.publishedAt}`);
    if (result.snippet) lines.push(`　摘要：${truncate(result.snippet, MAX_SNIPPET_LENGTH)}`);
    lines.push('');
  }

  lines.push(
    '根據以上結果回答。只講結果裡真的有的內容，沒查到就說沒查到。',
    '不用自己列出網址清單，系統會在回覆下方自動附上來源。',
  );

  return lines.join('\n');
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
