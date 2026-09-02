import { describe, expect, it } from 'vitest';
import { executeTool, toolsFor } from '../src/ai/tools/registry.js';
import { validateArgs } from '../src/ai/tools/types.js';
import type { ToolContext } from '../src/ai/tools/types.js';
import type { ToolParameterSchema } from '../src/ai/providers/types.js';
import { SearchRouter } from '../src/ai/search/router.js';
import { timeTool } from '../src/ai/tools/time.js';

const schema: ToolParameterSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', description: '名字' },
    count: { type: 'number', description: '數量' },
    flag: { type: 'boolean', description: '開關' },
    mode: { type: 'string', description: '模式', enum: ['fast', 'slow'] },
  },
  required: ['name'],
};

describe('工具參數驗證', () => {
  it('缺必填參數會被擋下', () => {
    expect(validateArgs(schema, {})).toEqual({ ok: false, message: '缺少必填參數 name。' });
  });

  it('參數不是物件也擋得下來', () => {
    expect(validateArgs(schema, 'not an object').ok).toBe(false);
    expect(validateArgs(schema, ['a']).ok).toBe(false);
    expect(validateArgs(schema, null).ok).toBe(false);
  });

  it('模型把數字寫成字串時自動轉換 —— 這種情況很常見，不該直接失敗', () => {
    const result = validateArgs(schema, { name: 'a', count: '42' });

    expect(result).toEqual({ ok: true, value: { name: 'a', count: 42 } });
  });

  it('轉不出數字才報錯', () => {
    const result = validateArgs(schema, { name: 'a', count: '一百' });

    expect(result.ok).toBe(false);
  });

  it('布林值接受字串形式的 true / false', () => {
    expect(validateArgs(schema, { name: 'a', flag: 'true' })).toMatchObject({
      value: { flag: true },
    });
    expect(validateArgs(schema, { name: 'a', flag: 'false' })).toMatchObject({
      value: { flag: false },
    });
    expect(validateArgs(schema, { name: 'a', flag: '是' }).ok).toBe(false);
  });

  it('enum 之外的值會被擋下，訊息列出可用選項', () => {
    const result = validateArgs(schema, { name: 'a', mode: 'turbo' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('fast、slow');
  });

  it('schema 沒定義的欄位不會被帶進結果，避免模型偷塞東西', () => {
    const result = validateArgs(schema, { name: 'a', injected: 'evil' });

    expect(result).toEqual({ ok: true, value: { name: 'a' } });
  });
});

function contextWith(overrides: Partial<ToolContext>): ToolContext {
  return {
    db: {} as never,
    guildId: 'g1',
    userId: 'u1',
    locale: 'zh-TW',
    memoryEnabled: true,
    search: new SearchRouter([]),
    timeoutMs: 1000,
    timezone: 'Asia/Taipei',
    ...overrides,
  };
}

describe('提供給模型的工具清單', () => {
  it('記憶關閉時不提供記憶相關工具 —— 關掉就是真的關掉，不是叫模型別用', () => {
    const names = toolsFor(contextWith({ memoryEnabled: false })).map((tool) => tool.name);

    expect(names).not.toContain('remember');
    expect(names).not.toContain('forget');
    expect(names).toContain('calculate');
  });

  it('記憶開啟時就會提供', () => {
    const names = toolsFor(contextWith({ memoryEnabled: true })).map((tool) => tool.name);

    expect(names).toContain('remember');
    expect(names).toContain('forget');
  });

  it('不提供 recall_memories —— 記憶已經全部注入 prompt，再查一次是白花一次請求', () => {
    const names = toolsFor(contextWith({ memoryEnabled: true })).map((tool) => tool.name);

    expect(names).not.toContain('recall_memories');
  });

  it('沒有搜尋來源時不提供搜尋工具，免得模型呼叫了才發現用不了', () => {
    const names = toolsFor(contextWith({ search: new SearchRouter([]) })).map((tool) => tool.name);

    expect(names).not.toContain('web_search');
  });

  it('有搜尋來源時才提供', () => {
    const fake = { id: 'tavily' as const, search: async () => [] };
    const names = toolsFor(contextWith({ search: new SearchRouter([fake]) })).map((t) => t.name);

    expect(names).toContain('web_search');
  });

  it('每個工具都有名稱、描述與 schema（規格 §29）', () => {
    for (const tool of toolsFor(contextWith({}))) {
      expect(tool.name).toMatch(/^[a-z_]+$/);
      expect(tool.description.length).toBeGreaterThan(10);
      expect(tool.parameters.type).toBe('object');
      expect(Array.isArray(tool.parameters.required)).toBe(true);
    }
  });
});

describe('工具執行', () => {
  it('模型呼叫不存在的工具時給出說明，而不是讓整輪對話失敗', async () => {
    const result = await executeTool(
      { id: '1', name: 'launch_missiles', args: {} },
      contextWith({}),
    );

    expect(result.text).toContain('沒有 launch_missiles 這個工具');
  });

  it('記憶關閉時就算模型硬呼叫記憶工具也會被擋下', async () => {
    const result = await executeTool(
      { id: '1', name: 'remember', args: { content: '偷存' } },
      contextWith({ memoryEnabled: false }),
    );

    expect(result.text).toContain('記憶功能目前是關閉的');
  });

  it('工具內部爆炸時轉成訊息，並要求模型不要編造結果', async () => {
    const exploding = contextWith({});

    // get_current_time 會讀 timezone，把它換成一讀就爆炸的 getter
    Object.defineProperty(exploding, 'timezone', {
      get() {
        throw new Error('boom');
      },
    });

    const result = await executeTool({ id: '1', name: 'get_current_time', args: {} }, exploding);

    expect(result.text).toContain('不要編造結果');
  });
});

describe('時間工具', () => {
  it('回傳含時區的時間', async () => {
    const result = await timeTool.execute({}, contextWith({}));

    expect(result.text).toContain('Asia/Taipei');
  });

  it('時區名稱無效時退回伺服器預設，而不是整個失敗', async () => {
    const result = await timeTool.execute({ timezone: 'Mars/Olympus' }, contextWith({}));

    expect(result.text).toContain('Asia/Taipei');
    expect(result.text).toContain('找不到時區');
  });
});
