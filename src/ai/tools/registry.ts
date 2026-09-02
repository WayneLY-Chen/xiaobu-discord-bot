import { logger } from '../../utils/logger.js';
import type { ToolCall, ToolDefinition } from '../providers/types.js';
import { calculatorTool } from './calculator.js';
import { imageTool } from './image.js';
import { forgetTool, rememberTool } from './memory.js';
import { searchTool } from './search.js';
import { timeTool } from './time.js';
import { weatherTool } from './weather.js';
import type { Tool, ToolContext, ToolResult } from './types.js';

const ALL_TOOLS: Tool[] = [
  searchTool,
  weatherTool,
  calculatorTool,
  timeTool,
  rememberTool,
  forgetTool,
  imageTool,
];

const BY_NAME = new Map(ALL_TOOLS.map((tool) => [tool.definition.name, tool]));

/**
 * 決定這一次要提供給模型哪些工具。
 *
 * 記憶類工具在記憶功能被關閉時不會出現 —— 使用者或管理員關掉記憶就是真的關掉，
 * 不能只靠 prompt 叫模型「不要用」。搜尋工具沒有可用的搜尋來源時也一樣不提供，
 * 免得模型呼叫了才發現用不了、白白浪費一輪。
 */
export function toolsFor(
  context: Pick<ToolContext, 'memoryEnabled' | 'imageEnabled' | 'search' | 'image'>,
): ToolDefinition[] {
  return ALL_TOOLS.filter((tool) => {
    if (tool.requiresMemory && !context.memoryEnabled) return false;
    // 管理員關掉生圖，或根本沒有可用的生圖來源時，都不提供這個工具
    if (tool.requiresImage && (!context.imageEnabled || !context.image.enabled)) return false;
    if (tool.definition.name === searchTool.definition.name && !context.search.enabled) return false;
    return true;
  }).map((tool) => tool.definition);
}

/**
 * 執行模型要求的工具。
 *
 * 任何失敗都轉成回給模型的文字而不是丟例外：工具壞掉不該讓整輪對話失敗，
 * 讓模型知道「這個工具這次不能用」再自己決定怎麼回答，體驗好得多。
 */
export async function executeTool(call: ToolCall, context: ToolContext): Promise<ToolResult> {
  const tool = BY_NAME.get(call.name);

  if (!tool) {
    logger.warn(`模型呼叫了不存在的工具：${call.name}`);
    return { text: `沒有 ${call.name} 這個工具，請用其他方式回答。` };
  }

  if (tool.requiresMemory && !context.memoryEnabled) {
    return { text: '記憶功能目前是關閉的，無法使用這個工具。' };
  }

  if (tool.requiresImage && (!context.imageEnabled || !context.image.enabled)) {
    return { text: '生圖功能目前是關閉的，無法使用這個工具。' };
  }

  try {
    return await tool.execute(call.args, context);
  } catch (error) {
    logger.error(`工具 ${call.name} 執行失敗`, error);
    return { text: `${call.name} 這次執行失敗了，請不要編造結果，據實告訴使用者。` };
  }
}

export { ALL_TOOLS };
